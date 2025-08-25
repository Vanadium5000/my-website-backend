// src/main.rs
use hmac::{Hmac, Mac};
use poem::{EndpointExt, Route, listener::TcpListener, middleware::Cors};
use poem_openapi::OpenApiService;
use sqlx::SqlitePool;

mod admin;
mod auth;
mod blog;
mod common;
mod general;

use admin::AdminApi;
use auth::AuthApi;
use blog::BlogApi;
use common::ServerKey;
use general::GeneralApi;

const SERVER_KEY: &[u8] = b"123456";

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
    tracing_subscriber::fmt::init();

    let pool = SqlitePool::connect("sqlite:db.sqlite3").await.unwrap();
    let api_service = OpenApiService::new(
        (AuthApi {}, GeneralApi {}, BlogApi {}),
        "My Website Backend",
        "1.0",
    )
    .server("http://localhost:3000/api");
    let ui = api_service.swagger_ui();
    let spec = api_service.spec_endpoint();

    let admin_api_service = OpenApiService::new(AdminApi {}, "My Website Backend", "1.0")
        .server("http://localhost:3000/admin_api");
    let admin_ui = admin_api_service.swagger_ui();
    let admin_spec = admin_api_service.spec_endpoint();

    // Configure CORS
    let cors = Cors::new()
        .allow_origins(vec!["http://localhost:5173", "http://localhost:3000"]) // Allow your frontend's origin
        .allow_methods(vec!["GET", "POST"]) // Allow specific methods
        .allow_headers(vec!["Authorization", "Content-Type"]) // Allow specific headers
        .allow_credentials(true); // Allow cookies/credentials if needed

    let server_key: ServerKey = Hmac::new_from_slice(SERVER_KEY).expect("valid server key");
    let app = Route::new()
        .nest("/api", api_service)
        .nest("/", ui)
        .nest("/openapi.json", spec)
        .nest("/admin_api", admin_api_service)
        .nest("/admin", admin_ui)
        .nest("/admin_openapi.json", admin_spec)
        .data(server_key)
        .data(pool)
        .with(cors); // Apply CORS middleware

    poem::Server::new(TcpListener::bind("0.0.0.0:3000"))
        .run(app)
        .await
}
