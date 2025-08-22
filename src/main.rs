use hmac::{Hmac, Mac};
use jwt::{SignWithKey, VerifyWithKey};
use poem::{
    EndpointExt, Request, Result, Route, error::InternalServerError, listener::TcpListener,
    web::Data,
};
use poem_openapi::{
    Object, OpenApi, OpenApiService, SecurityScheme,
    auth::Bearer,
    payload::{Json, PlainText},
};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const SERVER_KEY: &[u8] = b"123456";

type ServerKey = Hmac<Sha256>;

#[derive(Debug, Serialize, Deserialize)]
struct User {
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

#[derive(Object)]
struct LoginRequest {
    username: String,
    password: String,
}

struct Api;

#[OpenApi]
#[allow(unused_variables)]
impl Api {
    /// This is just a demo, so you can log in with any username and password.
    #[oai(path = "/login", method = "post")]
    async fn login(
        &self,
        server_key: Data<&ServerKey>,
        req: Json<LoginRequest>,
    ) -> Result<PlainText<String>> {
        let token = User {
            username: req.0.username,
        }
        .sign_with_key(server_key.0)
        .map_err(InternalServerError)?;
        Ok(PlainText(token))
    }

    /// This API returns the currently logged in user.
    #[oai(path = "/hello", method = "get")]
    async fn hello(&self, auth: BearerTokenAuthorization) -> PlainText<String> {
        PlainText(auth.0.username)
    }
}

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
    tracing_subscriber::fmt::init();

    let api_service =
        OpenApiService::new(Api, "Authorization Demo", "1.0").server("http://localhost:3000/api");
    let ui = api_service.swagger_ui();
    let server_key: Hmac<Sha256> = Hmac::new_from_slice(SERVER_KEY).expect("valid server key");
    let app = Route::new()
        .nest("/api", api_service)
        .nest("/", ui)
        .data(server_key);

    poem::Server::new(TcpListener::bind("0.0.0.0:3000"))
        .run(app)
        .await
}
