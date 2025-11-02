import { MongoClient, Db, Collection } from "mongodb";
import { Comment, Reaction, FlashcardDeck } from "./models";
import { UserDataSchema } from "../routes/connections";

// Define the user type with all our custom fields
import { ObjectId } from "mongodb";

// Derive the TS type & add the _id field
export type UserDocument = (typeof UserDataSchema)["static"] & {
  _id: ObjectId;
};

const uri = process.env.MONGO_URI as string;
if (!uri) throw new Error("MONGO_URI not set in .env");

let client: MongoClient;
let db: Db;
let userCollection: Collection<UserDocument>;
let commentsCollection: Collection<Comment>;
let reactionsCollection: Collection<Reaction>;
let flashcardsCollection: Collection<FlashcardDeck>;

export async function connectToDatabase() {
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db();
    userCollection = db.collection<UserDocument>("user");
    commentsCollection = db.collection<Comment>("comments");
    reactionsCollection = db.collection<Reaction>("reactions");
    flashcardsCollection = db.collection<FlashcardDeck>("flashcards");
    console.log("Connected to MongoDB");
  }
  return {
    db,
    userCollection,
    commentsCollection,
    reactionsCollection,
    flashcardsCollection,
  };
}
