// src/blog.rs
use poem::error::InternalServerError;
use poem::web::Data;
use poem_openapi::{
    ApiResponse, Object, OpenApi,
    payload::{Json, PlainText},
};
use sqlx::SqlitePool;

use crate::common::BearerTokenAuthorization;

/// Blog input
#[derive(Object)]
struct BlogCreateRequest {
    title: String,
    content: String,
    snippet: String,
}

#[derive(ApiResponse)]
enum BlogCreateResponse {
    /// Valid permissions
    #[oai(status = 200)]
    Ok(PlainText<String>),
    /// Invalid permissions
    #[oai(status = 404)]
    Unauthorized(PlainText<String>),
}

pub struct AdminApi {}

#[OpenApi]
impl AdminApi {
    /// Create a new blog post & returns its ID
    #[oai(path = "/create_post", method = "post")]
    async fn create(
        &self,
        pool: Data<&SqlitePool>,
        auth: BearerTokenAuthorization,
        req: Json<BlogCreateRequest>,
    ) -> Result<BlogCreateResponse, poem::Error> {
        if !auth.0.is_admin {
            return Ok(BlogCreateResponse::Unauthorized(PlainText(
                "invalid permissions".to_string(),
            )));
        }

        let post_id = sqlx::query!(
            "INSERT INTO blog_posts (title, content, snippet) VALUES (?, ?, ?)",
            req.0.title,
            req.0.content,
            req.0.snippet
        )
        .execute(pool.0)
        .await
        .map_err(InternalServerError)? // Return InternalServerError if sqlx errors
        .last_insert_rowid();

        Ok(BlogCreateResponse::Ok(PlainText(post_id.to_string())))
    }
}
