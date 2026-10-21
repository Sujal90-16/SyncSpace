require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { Server } = require("socket.io");

const prisma = require("./config/prisma");
const authRoutes = require("./routes/authRoutes");
const roomRoutes = require("./routes/roomRoutes");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

// Security middleware.
app.use(helmet());

// CORS configuration.
app.use(
  cors({
    origin: CLIENT_URL,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Request parsing and logging.
app.use(express.json({ limit: "100kb" }));
app.use(morgan("dev"));

// Socket.IO server.
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
  },
});

app.set("io", io);

// Root endpoint.
app.get("/", (req, res) => {
  res.status(200).json({
    message: "Welcome to SyncSpace API",
    status: "Running",
  });
});

// Health check.
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "SyncSpace Backend",
  });
});

// Authentication endpoints.
app.use("/api/auth", authRoutes);

// Room management endpoints.
app.use("/api/rooms", roomRoutes);

// Basic Socket.IO connection handling.
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("disconnect", (reason) => {
    console.log(`User disconnected: ${socket.id} (${reason})`);
  });
});

// Handle unknown endpoints.
app.use((req, res) => {
  res.status(404).json({
    message: "Route not found.",
  });
});

// Central error handler.
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (
    error instanceof SyntaxError &&
    error.status === 400 &&
    Object.prototype.hasOwnProperty.call(error, "body")
  ) {
    return res.status(400).json({
      message: "Invalid JSON request body.",
    });
  }

  console.error("Unhandled application error:", error.message);

  return res.status(500).json({
    message: "Internal server error.",
  });
});

// Start the application after connecting to PostgreSQL.
async function startServer() {
  try {
    if (!process.env.JWT_SECRET) {
      throw new Error("JWT_SECRET is missing from your .env file.");
    }

    await prisma.$connect();

    server.listen(PORT, () => {
      console.log(`SyncSpace server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
    });
  } catch (error) {
    console.error("Failed to start SyncSpace:", error.message);

    await prisma.$disconnect().catch(() => {});

    process.exitCode = 1;
  }
}

// Gracefully shut down the server.
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  console.log(`\nReceived ${signal}. Shutting down SyncSpace...`);

  const forceExitTimer = setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10000);

  forceExitTimer.unref();

  try {
    await new Promise((resolve) => {
      io.close(() => resolve());
    });

    await prisma.$disconnect();

    clearTimeout(forceExitTimer);

    console.log("SyncSpace shut down successfully.");
    process.exitCode = 0;
  } catch (error) {
    clearTimeout(forceExitTimer);

    console.error("Shutdown error:", error.message);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

startServer();
