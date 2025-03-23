require("dotenv").config();
const express = require("express");
const axios = require("axios");
const session = require("express-session");
const { Pool } = require('pg');
const pgSession = require('connect-pg-simple')(session);

const app = express();
const PORT = process.env.PORT;

// PostgreSQL Connection
const pool = new Pool({
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  database: process.env.PG_DATABASE,
});

// Test database connection
pool.connect()
  .then(() => console.log('PostgreSQL connected'))
  .catch(err => console.error('PostgreSQL connection error:', err));

// Create email_credentials table if it doesn't exist
const createTables = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_credentials (
        employee_name VARCHAR(255),
        email VARCHAR(255) PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at_ts BIGINT NOT NULL,
        expires_at VARCHAR(50) NOT NULL,
        token_uri TEXT,
        client_id VARCHAR(255),
        client_secret VARCHAR(255),
        scopes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
      );

      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
      END;
      $$ language 'plpgsql';

      DROP TRIGGER IF EXISTS update_email_credentials_updated_at ON email_credentials;
      
      CREATE TRIGGER update_email_credentials_updated_at
          BEFORE UPDATE ON email_credentials
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column();
    `);
    console.log('Tables created successfully');
  } catch (err) {
    console.error('Error creating tables:', err);
  }
};

createTables();

// Session setup with PostgreSQL
app.use(
  session({
    store: new pgSession({
      pool,
      tableName: 'session'
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
  })
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Google OAuth Configuration
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const SCOPES = [
  'profile',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose'
].join(' ');

console.log("Current Environment:", process.env.NODE_ENV);
console.log("Redirect URI:", REDIRECT_URI);

// User operations
const findUserByEmail = async (email) => {
  const result = await pool.query(
    'SELECT * FROM email_credentials WHERE email = $1',
    [email]
  );
  return result.rows[0];
};

const createOrUpdateUser = async (userData) => {
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
    profile_picture
  } = userData;

  try {
    const existingUser = await findUserByEmail(email);
    
    if (!existingUser) {
      // Create new user
      const result = await pool.query(`
        INSERT INTO email_credentials (
          employee_name, email, access_token, refresh_token, expires_at_ts,
          expires_at, token_uri, client_id, client_secret, scopes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `, [
        employee_name, email, access_token, refresh_token, expires_at_ts,
        expires_at, token_uri, client_id, client_secret, 
        Array.isArray(scopes) ? scopes.join(',') : scopes
      ]);
      console.log('New user created:', email);
      return result.rows[0];
    } else {
      // Update existing user
      const result = await pool.query(`
        UPDATE email_credentials
        SET employee_name = $1,
            access_token = $2,
            refresh_token = $3,
            expires_at_ts = $4,
            expires_at = $5,
            token_uri = $6,
            client_id = $7,
            client_secret = $8,
            scopes = $9
        WHERE email = $10
        RETURNING *
      `, [
        employee_name,
        access_token,
        refresh_token,
        expires_at_ts,
        expires_at,
        token_uri,
        client_id,
        client_secret,
        Array.isArray(scopes) ? scopes.join(',') : scopes,
        email
      ]);
      console.log('Existing user updated:', email);
      return result.rows[0];
    }
  } catch (error) {
    console.error('Error in createOrUpdateUser:', error);
    throw error;
  }
};

// Routes
app.get("/auth/google", (req, res) => {
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=profile email`;
  console.log('Auth URL:', url);
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

    // Find existing user
    const existingUser = await findUserByEmail(profile.email);

    let user;
    if (!existingUser) {
      // Create new user
      user = await createOrUpdateUser({
        employee_name: profile.name,
        email: profile.email,
        access_token: access_token,
        refresh_token: refresh_token || data.id_token, 
        expires_at_ts: expiresAtTs,
        expires_at: expiresAt,
        token_uri: "https://oauth2.googleapis.com/token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scopes: scope ? scope.split(" ") : []
      });
    } else {
      // Update existing user
      user = await createOrUpdateUser({
        ...existingUser,
        employee_name: profile.name,
        access_token: access_token,
        refresh_token: refresh_token || data.id_token || existingUser.refresh_token,
        expires_at_ts: expiresAtTs,
        expires_at: expiresAt,
        scopes: scope ? scope.split(" ") : existingUser.scopes
      });
    }

    // Update session with user data
    req.session.user = user;
    req.session.message = "Authentication successful";

    // Log the refresh_token in the session
    console.log("Refresh Token in Session:", req.session.user.refresh_token);

    res.redirect("/");
  } catch (error) {
    console.error("Error:", error.response?.data || error);
    req.session.message = "Authentication failed: " + (error.response?.data?.error_description || error.message);
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

  // console.log("Refresh Token in UI:", user ? user.refresh_token : "No user");

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
          background-color:rgb(107, 194, 31);
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
          .bg-red{
          background-color:rgb(5, 163, 134);
          padding: 30px 10px;
          border-radius: 8px;
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
                  user.profile_picture || user.profilePicture || ""
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
            <div class="bg-red">
              <button class="google-btn" onclick="document.getElementById('loginModal').style.display='block'">
                Sign in with Google
              </button>
              ${message ? `<p style="color: white;font-size: 20px; margin-top: 20px;">${message}</p>` : ''}
            </div>
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
        },
      </div>
      <script>
        // Close modal when clicking outside
        window.onclick = function(event) {
          const modal = document.getElementById('loginModal');
          if (event.target == modal) {
            modal.style.display = "none";
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
