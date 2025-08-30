use futures_util::{SinkExt, StreamExt};
use poem::{
    Error, IntoResponse, handler,
    http::StatusCode,
    web::{
        Data, Path,
        websocket::{Message, WebSocket},
    },
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc::Sender;
use tokio::sync::{RwLock, mpsc};
use uuid::Uuid;
mod common {
    include!("../common.rs");
}
use common::ServerKey;
use common::verify_token;
use shakmaty::{
    CastlingMode, Chess, Color, EnPassantMode, Outcome, Position,
    fen::{Epd, Fen},
    san::San,
};
pub struct ChessApi {}

// Define a struct for Game
#[derive(Clone)]
pub struct Game {
    player_white: String,
    player_black: Option<String>,
    fen: String,
    turn_white: bool,
    pos_counts: HashMap<String, u32>,
}

#[handler]
pub async fn ws(
    Path(token): Path<String>,
    server_key: Data<&ServerKey>,
    ws: WebSocket,
    clients: Data<&Arc<RwLock<HashMap<String, Sender<String>>>>>,
    games: Data<&Arc<RwLock<HashMap<String, Game>>>>,
) -> Result<impl IntoResponse, Error> {
    let user = verify_token(server_key.0.clone(), token.clone())
        .await
        .ok_or_else(|| Error::from_status(StatusCode::UNAUTHORIZED))?;
    let username = user.username;

    let mut games_guard = games.write().await;

    let mut existing_game_id: Option<String> = None;
    for (id, g) in games_guard.iter() {
        if g.player_white == username || g.player_black.as_ref() == Some(&username) {
            existing_game_id = Some(id.clone());
            break;
        }
    }

    let mut joined = false;
    let mut join_game_id: Option<String> = None;
    if existing_game_id.is_none() {
        for (id, g) in games_guard.iter_mut() {
            if g.player_black.is_none() {
                g.player_black = Some(username.clone());
                join_game_id = Some(id.clone());
                joined = true;
                break;
            }
        }
    }

    let game_id = if let Some(id) = existing_game_id {
        id
    } else if let Some(id) = join_game_id {
        id
    } else {
        let new_id = Uuid::new_v4().to_string();
        let initial_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1".to_string();
        games_guard.insert(
            new_id.clone(),
            Game {
                player_white: username.clone(),
                player_black: None,
                fen: initial_fen,
                turn_white: true,
                pos_counts: HashMap::new(),
            },
        );
        new_id
    };

    let is_joining_as_black = joined;
    let game = games_guard.get(&game_id).unwrap().clone();
    drop(games_guard);

    if is_joining_as_black {
        let clients_guard = clients.read().await;
        if let Some(tx) = clients_guard.get(&game.player_white) {
            let msg = format!(r#"{{"type":"opponent_joined","opponent":"{}"}}"#, username);
            let _ = tx.send(msg).await;
        }
    }

    let clients = clients.clone();
    let games = games.clone();
    Ok(ws.on_upgrade(move |socket| async move {
        let (mut sink, mut stream) = socket.split();

        let your_color = if game.player_white == username { "white" } else { "black" };
        let opponent: Option<String> = if your_color == "white" { game.player_black.clone() } else { Some(game.player_white.clone()) };
        let opponent_str = opponent.map(|s| format!("\"{}\"", s)).unwrap_or("null".to_string());
        let init_msg = format!(r#"{{"type":"init","fen":"{}","turn_white":{},"your_color":"{}","opponent":{}}}"#, game.fen, game.turn_white, your_color, opponent_str);
        let _ = sink.send(Message::Text(init_msg)).await;

        let (tx, mut rx) = mpsc::channel::<String>(32);
        clients.write().await.insert(username.clone(), tx);
        let clients_clone = clients.clone();
        let games_clone = games.clone();
        let username_clone = username.clone();
        let game_id_clone = game_id.clone();

        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(Message::Text(msg)).await.is_err() {
                    break;
                }
            }
        });

        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                if let Message::Text(text) = msg {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(move_san) = parsed["move"].as_str() {
                            let mut games_guard = games_clone.write().await;
                            if let Some(game) = games_guard.get_mut(&game_id_clone) {
                                let is_white = game.player_white == username_clone;
                                if (game.turn_white && is_white) || (!game.turn_white && !is_white) {
                                    let fen = match game.fen.parse::<Fen>() {
                                        Ok(f) => f,
                                        Err(_) => {
                                            drop(games_guard);
                                            let err_msg = r#"{"type":"error","message":"Invalid board state"}"#.to_string();
                                            let cg = clients_clone.read().await;
                                            if let Some(tx) = cg.get(&username_clone) {
                                                let _ = tx.send(err_msg).await;
                                            }
                                            continue;
                                        }
                                    };
                                    let pos: Chess = match fen.into_position(CastlingMode::Standard) {
                                        Ok(p) => p,
                                        Err(_) => {
                                            drop(games_guard);
                                            let err_msg = r#"{"type":"error","message":"Invalid board state"}"#.to_string();
                                            let cg = clients_clone.read().await;
                                            if let Some(tx) = cg.get(&username_clone) {
                                                let _ = tx.send(err_msg).await;
                                            }
                                            continue;
                                        }
                                    };
                                    let san = match move_san.parse::<San>() {
                                        Ok(s) => s,
                                        Err(_) => {
                                            drop(games_guard);
                                            let err_msg = r#"{"type":"error","message":"Invalid SAN"}"#.to_string();
                                            let cg = clients_clone.read().await;
                                            if let Some(tx) = cg.get(&username_clone) {
                                                let _ = tx.send(err_msg).await;
                                            }
                                            continue;
                                        }
                                    };
                                    let mv = match san.to_move(&pos) {
                                        Ok(m) => m,
                                        Err(_) => {
                                            drop(games_guard);
                                            let err_msg = r#"{"type":"error","message":"Invalid move"}"#.to_string();
                                            let cg = clients_clone.read().await;
                                            if let Some(tx) = cg.get(&username_clone) {
                                                let _ = tx.send(err_msg).await;
                                            }
                                            continue;
                                        }
                                    };
                                    let new_pos = match pos.play(mv) {
                                        Ok(np) => np,
                                        Err(_) => {
                                            drop(games_guard);
                                            let err_msg = r#"{"type":"error","message":"Invalid move"}"#.to_string();
                                            let cg = clients_clone.read().await;
                                            if let Some(tx) = cg.get(&username_clone) {
                                                let _ = tx.send(err_msg).await;
                                            }
                                            continue;
                                        }
                                    };
                                    game.fen = Fen::from_position(&new_pos.clone(), EnPassantMode::Legal).to_string();
                                    game.turn_white = !game.turn_white;
                                    let mut game_over = false;
                                    let mut update_msg = format!(r#"{{"type":"update","fen":"{}"}}"#, game.fen);
                                    let mut is_draw = false;
                                    match new_pos.outcome() {
                                        Outcome::Known(variant) => {
                                            game_over = true;
                                            match variant {
                                                shakmaty::KnownOutcome::Draw => {
                                                    is_draw = true;
                                                }
                                                shakmaty::KnownOutcome::Decisive { winner } => {
                                                    let winner_name = if winner == Color::White {
                                                        game.player_white.clone()
                                                    } else {
                                                        game.player_black.clone().unwrap_or_default()
                                                    };
                                                    update_msg = format!(r#"{{"type":"win","winner":"{}"}}"#, winner_name);
                                                    // HERE: Add logic to update scores in your sqlx DB
                                                    // e.g., sqlx::query!("UPDATE users SET score = score + 1 WHERE username = ?", winner_name).execute(&db_pool).await;
                                                }
                                            }
                                        }
                                        Outcome::Unknown => {
                                            if new_pos.halfmoves() >= 100 {
                                                is_draw = true;
                                            } else {
                                                let fen_str = Fen::from_position(&new_pos.clone(), EnPassantMode::Legal).to_string();
                                                let parts: Vec<&str> = fen_str.split_whitespace().collect();
                                                let pos_key = parts[0..4].join(" ");
                                                let count = game.pos_counts.entry(pos_key).or_insert(0);
                                                *count += 1;
                                                if *count >= 3 {
                                                    is_draw = true;
                                                }
                                            }
                                        }
                                    }
                                    if is_draw {
                                        game_over = true;
                                        update_msg = r#"{"type":"draw"}"#.to_string();
                                        // HERE: Add logic to handle draws in your sqlx DB if needed
                                    }
                                    drop(games_guard);
                                    let clients_guard = clients_clone.read().await;
                                    let games_read = games_clone.read().await;
                                    if let Some(game) = games_read.get(&game_id_clone) {
                                        if let Some(tx) = clients_guard.get(&game.player_white) {
                                            let _ = tx.send(update_msg.clone()).await;
                                        }
                                        if let Some(black) = &game.player_black {
                                            if let Some(tx) = clients_guard.get(black) {
                                                let _ = tx.send(update_msg.clone()).await;
                                            }
                                        }
                                    }
                                    if game_over {
                                        let mut games_write = games_clone.write().await;
                                        games_write.remove(&game_id_clone);
                                    }
                                } else {
                                    drop(games_guard);
                                    let err_msg = r#"{"type":"error","message":"Not your turn"}"#.to_string();
                                    let cg = clients_clone.read().await;
                                    if let Some(tx) = cg.get(&username_clone) {
                                        let _ = tx.send(err_msg).await;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            clients_clone.write().await.remove(&username_clone);
            let mut games_guard = games_clone.write().await;
            if let Some(game) = games_guard.get(&game_id_clone).cloned() {
                let disconnected_white = game.player_white == username_clone;
                let other_opt = if disconnected_white {
                    game.player_black.clone()
                } else {
                    Some(game.player_white.clone())
                };
                drop(games_guard);
                if let Some(other) = other_opt {
                    let win_msg = r#"{"type":"win","reason":"opponent disconnected"}"#.to_string();
                    let clients_g = clients_clone.read().await;
                    if let Some(tx) = clients_g.get(&other) {
                        let _ = tx.send(win_msg).await;
                        // HERE: Add logic to update scores in your sqlx DB for win by disconnect
                    }
                }
                let mut games_g = games_clone.write().await;
                games_g.remove(&game_id_clone);
            }
        });
    }))
}
