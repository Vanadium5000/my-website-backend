import { ObjectId } from "mongodb";

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface UserNotificationSubscription {
  eventType: string;
  methods: ("email" | "push")[];
  createdAt: Date;
}

export interface Comment {
  _id?: ObjectId;
  blogId: string;
  authorId: string;
  content: string;
  accepted: boolean;
  createdAt: Date;
}

export interface Reaction {
  _id?: ObjectId;
  blogId: string;
  userId: string;
  type: "like" | "dislike";
  createdAt: Date;
}

// Content elements for flashcards
export type ContentElement = TextContent | MediaContent;

export interface TextContent {
  text: string;
  type: "text";
}

export interface MediaContent {
  mediaUrl: string;
  type: "media";
}

export interface Flashcard {
  word: ContentElement[];
  definition: ContentElement[];
}

export interface FlashcardDeck {
  _id?: ObjectId;
  userId: string;
  title: string;
  lastModified: string; // ISO 8601 timestamp
  publishedTimestamp: string; // ISO 8601 timestamp
  description: string;
  thumbnail: string;
  cards: Flashcard[];
  createdAt: Date;
}

// Quizspire interfaces
export interface QuizspirePlayer {
  socket: any; // Socket.IO socket
  userId: string;
  username: string;
  score: number;
  correctAnswers: number;
  isHost: boolean;
  isGuest: boolean;
}

export interface QuizspireSettings {
  winCondition: "time" | "correct_answers" | "score";
  timeLimit?: number; // in seconds, for time-based win
  correctAnswersThreshold?: number; // for correct answers win
  scoreThreshold?: number; // for score win
  resetOnIncorrect: boolean; // reset progress on wrong answer
  questionTimeLimit: number; // time per question in seconds
  allowLateJoin: boolean; // allow players to join after game has started
  hostParticipates: boolean; // whether the host participates as a player
}

export interface QuizspireQuestion {
  question: ContentElement[]; // from flashcard word
  options: ContentElement[][]; // 4 options, first is correct
  correctIndex: number; // index of correct answer (0-3)
}

export interface QuizspireLobby {
  code: string; // 6-digit code
  host: QuizspirePlayer;
  players: QuizspirePlayer[];
  deckId: string;
  settings: QuizspireSettings;
  status: "waiting" | "starting" | "playing" | "ended";
}

export interface QuizspireGame {
  lobby: QuizspireLobby;
  currentQuestionIndex: number;
  questions: QuizspireQuestion[];
  questionStartTime: number; // timestamp when question started
  answersSubmitted: Map<string, number>; // userId -> selected option index
  timer?: NodeJS.Timeout;
}
