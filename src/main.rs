use hmac::{Hmac, Mac};
use jwt::{SignWithKey, VerifyWithKey};
use poem::{
    EndpointExt, Request, Result, Route, error::InternalServerError, listener::TcpListener,
    web::Data,
};
use poem_openapi::{
    ApiResponse, Object, OpenApi, OpenApiService, SecurityScheme,
    auth::Bearer,
    payload::{Json, PlainText},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use sqlx::SqlitePool;

// Private server key, used for signing authentication tokens
const SERVER_KEY: &[u8] = b"123456";

type ServerKey = Hmac<Sha256>;

// User type
#[derive(Debug, Serialize, Deserialize, poem_openapi::Object)]
struct User {
    user_id: i64,
    username: String,
}

/// ApiKey authorization
#[derive(SecurityScheme)]
#[oai(ty = "bearer", bearer_format = "JWT", checker = "api_checker")]
struct BearerTokenAuthorization(User);

async fn api_checker(req: &Request, bearer: Bearer) -> Option<User> {
    let server_key = req.data::<ServerKey>().unwrap();
    VerifyWithKey::<User>::verify_with_key(bearer.token.as_str(), server_key).ok()
}

// Define the API response enums with success and error cases
#[derive(ApiResponse)]
enum LoginResponse {
    /// User found successfully
    #[oai(status = 200)]
    Ok(PlainText<String>),
    /// User not found
    #[oai(status = 404)]
    NotFound(PlainText<String>),
}

#[derive(Object)]
struct LoginRequest {
    username: String,
    password: String,
}

// Main API
struct Api;

#[OpenApi]
impl Api {
    // Register & return the user id in plain text
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

    // Login & return JWT token in plain text
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
                return Ok(LoginResponse::NotFound(PlainText(
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

    /// Returns the currently logged in user
    #[oai(path = "/hello", method = "get")]
    async fn hello(&self, auth: BearerTokenAuthorization) -> PlainText<String> {
        PlainText(auth.0.username)
    }
}

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
    tracing_subscriber::fmt::init();

    let pool = SqlitePool::connect("sqlite:db.sqlite3").await.unwrap();
    let api_service =
        OpenApiService::new(Api, "My Website Backend", "1.0").server("http://localhost:3000/api");
    let ui = api_service.swagger_ui();
    let server_key: Hmac<Sha256> = Hmac::new_from_slice(SERVER_KEY).expect("valid server key");
    let app = Route::new()
        .nest("/api", api_service)
        .nest("/", ui)
        .data(server_key)
        .data(pool);

    poem::Server::new(TcpListener::bind("0.0.0.0:3000"))
        .run(app)
        .await
}
