require("dotenv").config();
const express = require("express");
const axios = require("axios");
const session = require("express-session");
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT;

// First, connect to PostgreSQL default database to create our database if it doesn't exist
const initPool = new Pool({
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  database: 'postgres' // Connect to default database first
});

// User operations
async function findUserByGoogleId(pool, googleId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE google_id = $1',
    [googleId]
  );
  return result.rows[0];
}

async function createUser(pool, userData) {
  const {
    employee_name,
    email,
    access_token,
    refresh_token,
    expires_at_ts,
    expires_at,
    token_uri,
    client_id,
    client_secret,
    scopes,
    google_id,
    profile_picture
  } = userData;

  const result = await pool.query(`
    INSERT INTO users (
      employee_name, email, access_token, refresh_token, expires_at_ts,
      expires_at, token_uri, client_id, client_secret, scopes,
      google_id, profile_picture
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *
  `, [
    employee_name,
    email,
    access_token,
    refresh_token,
    expires_at_ts,
    expires_at,
    token_uri,
    client_id,
    client_secret,
    scopes,
    google_id,
    profile_picture
  ]);

  return result.rows[0];
}

async function updateUser(pool, googleId, userData) {
  const {
    access_token,
    refresh_token,
    expires_at_ts,
    expires_at,
    scopes
  } = userData;

  const result = await pool.query(`
    UPDATE users
    SET access_token = $1,
        refresh_token = COALESCE($2, refresh_token),
        expires_at_ts = $3,
        expires_at = $4,
        scopes = $5,
        updated_at = CURRENT_TIMESTAMP
    WHERE google_id = $6
    RETURNING *
  `, [
    access_token,
    refresh_token,
    expires_at_ts,
    expires_at,
    scopes,
    googleId
  ]);

  return result.rows[0];
}

// Initialize database
async function initializeDatabase() {
  try {
    // Check if database exists
    const checkDb = await initPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [process.env.PG_DATABASE]
    );

    // Create database if it doesn't exist
    if (checkDb.rows.length === 0) {
      await initPool.query(`CREATE DATABASE "${process.env.PG_DATABASE}"`);
      console.log(`Database ${process.env.PG_DATABASE} created successfully`);
    }
    
    await initPool.end(); // Close the initial connection

    // Now connect to our actual database
    const pool = new Pool({
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      host: process.env.PG_HOST,
      port: process.env.PG_PORT,
      database: process.env.PG_DATABASE,
    });

    const createTableQuery = `
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        employee_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at_ts BIGINT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        token_uri VARCHAR(255) NOT NULL,
        client_id TEXT NOT NULL,
        client_secret TEXT NOT NULL,
        scopes TEXT[],
        google_id VARCHAR(255) NOT NULL UNIQUE,
        profile_picture TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Create indexes for better performance
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
      CREATE INDEX IF NOT EXISTS idx_users_expires_at ON users(expires_at);
      
      -- Session table with improved structure
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
        "sess" jsonb NOT NULL,
        "expire" timestamp(6) NOT NULL,
        "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
      );

      -- Create index for session expiry
      CREATE INDEX IF NOT EXISTS idx_session_expire ON "session"("expire");

      -- Create or replace function to update timestamp
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
      END;
      $$ language 'plpgsql';

      -- Create triggers for updating timestamps
      DROP TRIGGER IF EXISTS update_users_updated_at ON users;
      CREATE TRIGGER update_users_updated_at
          BEFORE UPDATE ON users
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();

      DROP TRIGGER IF EXISTS update_session_updated_at ON "session";
      CREATE TRIGGER update_session_updated_at
          BEFORE UPDATE ON "session"
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
    `;

    await pool.query(createTableQuery);
    console.log("Tables and indexes created successfully");

    return pool;
  } catch (err) {
    console.error("Database initialization error:", err);
    process.exit(1);
  }
}

// Initialize the database and start the server
let pool;
initializeDatabase()
  .then((p) => {
    pool = p;
    console.log("PostgreSQL connected successfully");
    
    // Session setup
    app.use(
      session({
        store: new pgSession({
          pool,
          tableName: 'session',
          createTableIfMissing: true
        }),
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 1000 * 60 * 60 * 24 }
      })
    );

    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());

    // Google OAuth Configuration
    const CLIENT_ID = process.env.CLIENT_ID;
    const CLIENT_SECRET = process.env.CLIENT_SECRET;
    const REDIRECT_URI =
      process.env.NODE_ENV === "production"
        ? process.env.REDIRECT_URI_PROD
        : process.env.REDIRECT_URI_DEV;

    // Add this for debugging
    console.log("Current Environment:", process.env.NODE_ENV);
    console.log("Redirect URI:", REDIRECT_URI);

    // Routes
    app.get("/auth/google", (req, res) => {
      const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=profile email&access_type=offline&prompt=consent`;
      res.redirect(url);
    });

    app.get("/api/auth/google/callback", async (req, res) => {
      const { code } = req.query;
      try {
        const { data } = await axios.post("https://oauth2.googleapis.com/token", {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
        });

        // Log the token response to debug
        console.log("Token Response:", data);

        const { access_token, refresh_token, expires_in, scope } = data;

        const { data: profile } = await axios.get(
          "https://www.googleapis.com/oauth2/v1/userinfo",
          {
            headers: { Authorization: `Bearer ${access_token}` },
          }
        );

        const expiresAtTs = Date.now() + expires_in * 1000;
        const expiresAt = new Date(expiresAtTs).toISOString();

        let user = await findUserByGoogleId(pool, profile.id);
        
        if (!user) {
          // Create new user
          user = await createUser(pool, {
            employee_name: profile.name,
            email: profile.email,
            access_token,
            refresh_token,
            expires_at_ts: expiresAtTs,
            expires_at: expiresAt,
            token_uri: "https://oauth2.googleapis.com/token",
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            scopes: scope ? scope.split(" ") : [],
            google_id: profile.id,
            profile_picture: profile.picture
          });
          console.log("New user created:", user.email);
        } else {
          // Update existing user
          user = await updateUser(pool, profile.id, {
            access_token,
            refresh_token,
            expires_at_ts: expiresAtTs,
            expires_at: expiresAt,
            scopes: scope ? scope.split(" ") : user.scopes
          });
          console.log("User updated:", user.email);
        }

        // Update the session
        req.session.user = user;
        req.session.message = "Authentication successful";

        res.redirect("/");
      } catch (error) {
        console.error("Error:", error);
        req.session.message = "Authentication failed";
        res.redirect("/");
      }
    });

    app.get("/logout", (req, res) => {
      req.session.destroy(() => {
        res.redirect("/");
      });
    });

    // Main Route with HTML
    app.get("/", (req, res) => {
      const user = req.session.user;
      const message = req.session.message || "";
      delete req.session.message;

      res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Google Auth App</title>
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background-color: #f5f5f5;
            }
            .container {
              text-align: center;
              width: 100%;
              max-width: 400px;
            }
            .google-btn {
              background-color: #4285f4;
              color: white;
              padding: 12px 24px;
              border: none;
              border-radius: 50px;
              cursor: pointer;
              font-size: 16px;
              font-weight: 500;
              transition: all 0.3s ease;
              box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }
            .google-btn:hover {
              background-color: #357abd;
              transform: translateY(-1px);
              box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            }
            .modal {
              display: none;
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background-color: rgba(0,0,0,0.5);
              backdrop-filter: blur(5px);
              z-index: 1000;
            }
            .modal-content {
              background-color: white;
              margin: 10% auto;
              padding: 32px;
              border-radius: 16px;
              width: 90%;
              max-width: 400px;
              text-align: center;
              position: relative;
              box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            }
            .close {
              position: absolute;
              right: 20px;
              top: 15px;
              cursor: pointer;
              font-size: 24px;
              color: #666;
              transition: color 0.3s ease;
            }
            .close:hover {
              color: #333;
            }
            .profile-img {
              border-radius: 50%;
              width: 120px;
              height: 120px;
              margin: 10px 0;
              object-fit: cover;
              border: 4px solid #fff;
              box-shadow: 0 4px 8px rgba(0,0,0,0.1);
            }
            .success-message {
              color: #28a745;
              background-color: #d4edda;
              border-radius: 8px;
              padding: 10px;
              margin: 15px 0;
              font-size: 14px;
            }
            .error-message {
              color: #dc3545;
              background-color: #f8d7da;
              border-radius: 8px;
              padding: 10px;
              margin: 15px 0;
              font-size: 14px;
            }
            h2 {
              color: #333;
              margin: 0 0 20px 0;
              font-size: 24px;
              font-weight: 600;
            }
            .user-name {
              font-size: 28px;
              font-weight: 600;
              color: #333;
              margin: 10px 0;
            }
            .auth-container {
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 20px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            ${
              user
                ? `
              <div id="profileModal" class="modal" style="display: block;">
                <div class="modal-content">
                  <span class="close" onclick="window.location.href='/logout'">×</span>
                  <div class="auth-container">
                    ${
                      message
                        ? `<p class="${
                            message.includes("failed")
                              ? "error-message"
                              : "success-message"
                          }">${message}</p>`
                        : ""
                    }
                    <img src="${
                      user.profile_picture || ""
                    }" alt="Profile" class="profile-img">
                    <h2 class="user-name">${user.employee_name || "User"}</h2>
                    <p style="color: #666; margin: 0;">Authentication successful</p>
                    <button onclick="window.location.href='/logout'" class="google-btn">
                      Sign Out
                    </button>
                  </div>
                </div>
              </div>
            `
                : `
              <button class="google-btn" onclick="document.getElementById('loginModal').style.display='block'">
                Sign in with Google
              </button>
              <div id="loginModal" class="modal">
                <div class="modal-content">
                  <span class="close" onclick="document.getElementById('loginModal').style.display='none'">×</span>
                  <div class="auth-container">
                    <h2>Welcome Back!</h2>
                    <p style="color: #666; margin: 0;">Please sign in to continue</p>
                    <a href="/auth/google" style="text-decoration: none;">
                      <button class="google-btn">Sign in with Google</button>
                    </a>
                  </div>
                </div>
              </div>
            `
            }
          </div>
        </body>
        </html>
      `);
    });

    // Start Server
    app.listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
    });
  });
