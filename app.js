const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");

const app = express();

// MongoDB Connection
mongoose
  .connect("mongodb+srv://googleauth:googleauth@cluster0.g7kho.mongodb.net/", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Session setup
app.use(
  session({
    secret: "chat",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl:
        "mongodb+srv://googleauth:googleauth@cluster0.g7kho.mongodb.net",
    }),
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
  })
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Google OAuth Configuration
const CLIENT_ID =
  "729112626275-i4mb680i07u4h0li00ca8fblk8bkpgog.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:3000/api/auth/google/callback";

// User Schema
const userSchema = new mongoose.Schema({
  googleId: String,
  displayName: String,
  email: String,
  profilePicture: String,
});
const User = mongoose.model("User", userSchema);

// Routes
app.get("/auth/google", (req, res) => {
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=profile email`;
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

    const { access_token } = data;
    const { data: profile } = await axios.get(
      "https://www.googleapis.com/oauth2/v1/userinfo",
      {
        headers: { Authorization: `Bearer ${access_token}` },
      }
    );

    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = new User({
        googleId: profile.id,
        displayName: profile.name,
        email: profile.email,
        profilePicture: profile.picture,
      });
      await user.save();
    }

    req.session.user = user;
    res.redirect("/");
  } catch (error) {
    console.error("Error:", error);
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
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Google Auth App</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
          background-color: #f0f0f0;
        }
        .container {
          text-align: center;
        }
        .google-btn {
          background-color: #4285f4;
          color: white;
          padding: 10px 20px;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          font-size: 16px;
        }
        .google-btn:hover {
          background-color: #357abd;
        }
        .modal {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background-color: rgba(0,0,0,0.5);
        }
        .modal-content {
          background-color: white;
          margin: 15% auto;
          padding: 20px;
          border-radius: 5px;
          width: 300px;
          text-align: center;
        }
        .close {
          float: right;
          cursor: pointer;
          font-size: 24px;
        }
        .profile-img {
          border-radius: 50%;
          width: 100px;
          height: 100px;
          margin: 10px 0;
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
              <h2>Welcome, ${user.displayName}!</h2>
              <img src="${user.profilePicture}" alt="Profile" class="profile-img">
              <p>${user.email}</p>
              <button onclick="window.location.href='/logout'" class="google-btn">Logout</button>
            </div>
          </div>
        `
            : `
          <button class="google-btn" onclick="document.getElementById('loginModal').style.display='block'">Login with Google</button>
          <div id="loginModal" class="modal">
            <div class="modal-content">
              <span class="close" onclick="document.getElementById('loginModal').style.display='none'">×</span>
              <h2>Login</h2>
              <p>Sign in with your Google account</p>
              <a href="/auth/google">
                <button class="google-btn">Google Login</button>
              </a>
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
app.listen(3000, () => {
  console.log("Server started on port 3000");
});
