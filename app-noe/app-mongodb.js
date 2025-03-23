require("dotenv").config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");

const app = express();
const PORT = process.env.PORT;
// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Session setup
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGODB_URI,
    }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
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

// User Schema with all requested fields
const userSchema = new mongoose.Schema({
  employee_name: String,
  email: String,
  access_token: String,
  refresh_token: String,
  expires_at_ts: Number,
  expires_at: String,
  token_uri: String,
  client_id: String,
  client_secret: String,
  scopes: [String],
  googleId: String,
  profilePicture: String,
});
const User = mongoose.model("User", userSchema);

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

    let user = await User.findOne({ googleId: profile.id });
    const expiresAtTs = Date.now() + expires_in * 1000;
    const expiresAt = new Date(expiresAtTs).toISOString();

    if (!user) {
      user = new User({
        employee_name: profile.name,
        email: profile.email,
        access_token: access_token,
        refresh_token: refresh_token,
        expires_at_ts: expiresAtTs,
        expires_at: expiresAt,
        token_uri: "https://oauth2.googleapis.com/token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scopes: scope ? scope.split(" ") : [],
        googleId: profile.id,
        profilePicture: profile.picture,
      });
      await user.save();
    } else {
      // Update the user with new token information
      user.access_token = access_token;
      if (refresh_token) {
        user.refresh_token = refresh_token;
      }
      user.expires_at_ts = expiresAtTs;
      user.expires_at = expiresAt;
      user.scopes = scope ? scope.split(" ") : user.scopes || [];
      await user.save();

      // Reload the user from the database to ensure we have the latest data
      user = await User.findOne({ googleId: profile.id });
    }

    // Update the session with the reloaded user
    req.session.user = user;
    req.session.message = "Authentication successful";

    // Log the refresh_token in the session
    // console.log("Refresh Token in Session:", req.session.user.refresh_token);

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

  // Log the refresh_token being displayed in the UI
  console.log("Refresh Token in UI:", user ? user.refresh_token : "No user");

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
                  user.profilePicture || ""
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
  console.log("Server started on port 3000");
});
