// src/auth.rs
use jwt::SignWithKey;
use poem::{Result, error::InternalServerError, web::Data};
use poem_openapi::{
    ApiResponse, Object, OpenApi,
    payload::{Json, PlainText},
};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::common::{ServerKey, User};

/// Login response
#[derive(ApiResponse)]
enum LoginResponse {
    /// Valid credentials
    #[oai(status = 200)]
    Ok(PlainText<String>),
    /// Invalid credentials
    #[oai(status = 401)]
    Unauthorized(PlainText<String>),
}

/// Login input
#[derive(Object)]
struct LoginRequest {
    username: String,
    password: String,
}

pub struct AuthApi {}

#[OpenApi]
impl AuthApi {
    /// Register & return the user id in plain text
    #[oai(path = "/register", method = "post")]
    async fn register(
        &self,
        _server_key: Data<&ServerKey>,
        pool: Data<&SqlitePool>,
        req: Json<LoginRequest>,
    ) -> Result<PlainText<String>> {
        // Generate a password_hash
        let password_hash = Sha256::new().chain_update(req.0.password.trim()).finalize();
        let password_hash_string = format!("{:x}", password_hash); // Returns hex string

        // Insert user & return ID
        let id = sqlx::query!(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            req.0.username,
            password_hash_string
        )
        .execute(pool.0)
        .await
        .map_err(InternalServerError)? // Return InternalServerError if sqlx errors
        .last_insert_rowid();

        Ok(PlainText(id.to_string()))
    }

    /// Login & return JWT token in plain text
    #[oai(path = "/login", method = "post")]
    async fn login(
        &self,
        server_key: Data<&ServerKey>,
        pool: Data<&SqlitePool>,
        req: Json<LoginRequest>,
    ) -> Result<LoginResponse> {
        // Generate a password_hash
        let password_hash = Sha256::new().chain_update(req.0.password.trim()).finalize();
        let password_hash_string = format!("{:x}", password_hash); // Returns hex string

        // Find user with same username/password_hash
        let user: Option<User> = sqlx::query_as!(
            User,
            "SELECT user_id, username FROM users WHERE username = ? AND password_hash = ?",
            req.0.username,
            password_hash_string
        )
        .fetch_optional(pool.0)
        .await
        .map_err(InternalServerError)?; // Return InternalServerError if sqlx errors

        // Check if user exists, error if not
        match user {
            // If user is none, return a not found error
            None => {
                return Ok(LoginResponse::Unauthorized(PlainText(
                    "invalid credentials".to_string(),
                )));
            }
            // If user exists, create & sign a token with server_key & return it in plain text
            Some(user) => {
                let token = User {
                    user_id: user.user_id,
                    username: user.username,
                }
                .sign_with_key(server_key.0)
                .map_err(InternalServerError)?;
                Ok(LoginResponse::Ok(PlainText(token)))
            }
        }
    }
}
