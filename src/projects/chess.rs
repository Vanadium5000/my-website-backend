use futures_util::{SinkExt, StreamExt};

use poem::{
    Error, IntoResponse, handler,
    http::StatusCode,
    web::{
        Data, Path,
        websocket::{Message, WebSocket},
    },
};
use tokio::sync::mpsc::Sender;
use tokio::sync::{RwLock, mpsc};

use std::collections::HashMap;
use std::sync::Arc;

mod common {
    include!("../common.rs");
}
use common::ServerKey;
use common::verify_token;

pub struct ChessApi {}

#[handler]
pub async fn ws(
    Path(token): Path<String>,
    server_key: Data<&ServerKey>,
    ws: WebSocket,
    clients: Data<&Arc<RwLock<HashMap<String, Sender<String>>>>>,
) -> Result<impl IntoResponse, Error> {
    // Verify token and get username
    let user = verify_token(server_key.0.clone(), token.clone())
        .await
        .ok_or_else(|| Error::from_status(StatusCode::UNAUTHORIZED))?;
    let username = user.username;

    let clients = clients.clone();
    Ok(ws.on_upgrade(move |socket| async move {
        let (mut sink, mut stream) = socket.split();

        // Create a channel for this client
        let (tx, mut rx) = mpsc::channel::<String>(32);

        // Add client to the map
        clients.write().await.insert(username.clone(), tx);

        let clients_clone = clients.clone();
        let username_clone = username.clone();

        // Spawn writer task: receive from client's channel and send to sink
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if sink.send(Message::Text(msg)).await.is_err() {
                    break;
                }
            }
        });

        // Spawn reader task: read from stream, parse, and route to target
        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                if let Message::Text(text) = msg {
                    // Parse JSON (adjust as needed for your message format)
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let (Some(to), Some(message)) =
                            (parsed["to"].as_str(), parsed["message"].as_str())
                        {
                            let clients_guard = clients_clone.read().await;
                            if let Some(target_tx) = clients_guard.get(to) {
                                if target_tx
                                    .send(format!("{}: {}", username_clone, message))
                                    .await
                                    .is_err()
                                {
                                    // Optional: handle send error
                                }
                            }
                        }
                    }
                }
            }

            // Cleanup on disconnect
            clients_clone.write().await.remove(&username_clone);
        });
    }))
}
