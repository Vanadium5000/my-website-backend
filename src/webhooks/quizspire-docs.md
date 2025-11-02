# Quizspire Socket Events Documentation

## Overview

Quizspire is a multiplayer quiz game system using flashcard decks. Players join lobbies with 6-digit codes, answer multiple-choice questions, and compete based on configurable win conditions.

## Authentication

Host creation requires a valid session cookie. Guest players can join without authentication but can provide custom usernames. Authentication follows the same pattern as other socket namespaces.

## Lobby Management

### Create Lobby

**Event:** `create_lobby`
**Direction:** Client → Server
**Data:**

```typescript
{
  deckId: string; // ObjectId of flashcard deck (must be owned by user)
  settings: QuizspireSettings;
}
```

**Response Events:**

- `lobby_created` - Success: `{ code: string }`
- `error` - Failure: `{ message: string }`

### Join Lobby

**Event:** `join_lobby`
**Direction:** Client → Server
**Data:**

```typescript
{
  code: string; // 6-digit lobby code
  username?: string; // Optional custom username for guest players
}
```

**Response Events:**

- `lobby_joined` - Success: `{ code: string }`
- `error` - Failure: `{ message: string }`

**Notes:**

- Guests can provide custom usernames
- Late joins allowed if `allowLateJoin` setting is enabled and game is in progress
- Authenticated users use their account username

### Lobby Updates

**Event:** `lobby_update`
**Direction:** Server → Client
**Data:**

```typescript
{
  code: string;
  players: Array<{
    userId: string;
    username: string;
    isHost: boolean;
    isGuest: boolean;
  }>;
  status: "waiting" | "starting" | "playing" | "ended";
  deckId: string;
  settings: QuizspireSettings;
}
```

### Leave Lobby

**Event:** `leave_lobby`
**Direction:** Client → Server
**Data:** None
**Notes:** Automatically handled on disconnect

## Game Settings

```typescript
interface QuizspireSettings {
  winCondition: "time" | "correct_answers" | "score";
  timeLimit?: number; // seconds, required if winCondition === "time"
  correctAnswersThreshold?: number; // required if winCondition === "correct_answers"
  scoreThreshold?: number; // required if winCondition === "score"
  resetOnIncorrect: boolean; // reset correct answers count on wrong answer
  questionTimeLimit: number; // seconds per question
  allowLateJoin: boolean; // allow players to join after game has started
  hostParticipates: boolean; // whether the host participates as a player
}
```

## Game Flow

### Start Game

**Event:** `start_game`
**Direction:** Client → Server (Host only)
**Data:**

```typescript
{
  settings?: QuizspireSettings; // Optional: Update lobby settings before starting
}
```

**Requirements:** At least 1 player, valid deck with cards
**Response Events:**

- `error` - Failure: `{ message: string }`

**Notes:** If settings are provided, they will override the current lobby settings before the game begins.

### Question Presentation

**Event:** `question`
**Direction:** Server → Client
**Data:**

```typescript
{
  questionIndex: number;
  question: ContentElement[]; // Flashcard word/content
  options: ContentElement[][]; // 4 multiple choice options
  timeLimit: number; // seconds
}
```

### Submit Answer

**Event:** `submit_answer`
**Direction:** Client → Server
**Data:**

```typescript
{
  selectedIndex: number; // 0-3
}
```

**Response Events:**

- `answer_feedback` - Immediate feedback: `{ isCorrect: boolean, pointsGained: number, correctIndex: number, selectedIndex: number }`

**Notes:**

- Can only submit once per question
- Invalid indices rejected
- Timeout = no answer submitted
- Immediate feedback sent to individual player before question results

### Question Results

**Event:** `question_results`
**Direction:** Server → Client
**Data:**

```typescript
{
  questionIndex: number;
  correctIndex: number; // 0-3
  results: Array<{
    userId: string;
    username: string;
    selectedIndex: number; // -1 = timeout/no answer
    isCorrect: boolean;
    timeTaken: number | null; // milliseconds, null if timeout
    score: number;
    isGuest: boolean;
  }>;
}
```

### Leaderboard Update

**Event:** `leaderboard_update`
**Direction:** Server → Client
**Data:**

```typescript
{
  leaderboard: Array<{
    userId: string;
    username: string;
    score: number;
    correctAnswers: number;
    isGuest: boolean;
  }>; // Sorted by score descending
  winCondition: "time" | "correct_answers" | "score";
  threshold?: number; // Current threshold value for progress tracking
}
```

**Notes:** Sent after each question to show real-time progress towards win condition

### Game End

**Event:** `game_ended`
**Direction:** Server → Client
**Data:**

```typescript
{
  reason: string; // "all_questions_completed" | "correct_answers_threshold_reached" | "score_threshold_reached" | "time_up"
  finalScores: Array<{
    userId: string;
    username: string;
    score: number;
    correctAnswers: number;
    isGuest: boolean;
  }>; // Sorted by win condition (score or correct_answers)
  winner: {
    userId: string;
    username: string;
    score: number;
    correctAnswers: number;
    isGuest: boolean;
  }
}
```

### Restart Game

**Event:** `restart_game`
**Direction:** Client → Server (Host only)
**Data:** None
**Requirements:** Game must be in "ended" status
**Response Events:**

- `error` - Failure: `{ message: string }`

**Notes:** Resets all player scores and correct answers, generates new questions, and starts a new game with the same players and settings.

### Kick Player

**Event:** `kick_player`
**Direction:** Client → Server (Host only)
**Data:**

```typescript
{
  userId: string; // UserId of player to kick
}
```

**Response Events:**

- `kicked` - To kicked player: `{ reason: string }`
- `error` - Failure: `{ message: string }`

**Notes:** Host can kick any player except themselves

## Error Handling

**Event:** `error`
**Direction:** Server → Client
**Data:**

```typescript
{
  message: string;
}
```

## Content Element Structure

```typescript
type ContentElement = TextContent | MediaContent;

interface TextContent {
  text: string;
  type: "text";
}

interface MediaContent {
  mediaUrl: string;
  type: "media";
}
```

## Game Logic Details

### Question Generation

- Questions from flashcard "word" field
- Correct answer from flashcard "definition" field
- 3 incorrect options randomly selected from other definitions in same deck
- Options shuffled randomly

### Scoring

- Base score: 100 points per correct answer
- Time bonus: +10 points per second remaining (max questionTimeLimit seconds)
- Incorrect answers: 0 points
- Reset on incorrect: Optional, resets correctAnswers count to 0

### Win Conditions

- **Time-based:** Game ends after timeLimit seconds
- **Correct answers:** Game ends when any player reaches correctAnswersThreshold
- **Score-based:** Game ends when any player reaches scoreThreshold

### Edge Cases Handled

- Invalid lobby codes
- Lobby full (50 player limit)
- Host disconnection (new host assigned)
- Player reconnection
- Invalid answer indices
- Question timeouts
- Empty decks
- Unauthorized deck access
- Multiple answer submissions
- Game state consistency
- Guest players with custom names
- Late joins during active games
- Host participation toggle
- Win condition threshold checks
- Player kicking by host
- Real-time leaderboard updates
- Game restart functionality
- Guest player identification

## Sequence Diagram

```
Host: create_lobby → lobby_created
Players: join_lobby → lobby_joined
Host: start_game → (validation)
Server: question → (to all players)
Players: submit_answer → (individual)
Server: question_results → (to all players)
... (repeat for each question)
Server: game_ended → (to all players)
Host: restart_game → (validation)
Server: question → (to all players)
... (repeat for new game)
```
