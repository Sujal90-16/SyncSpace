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
const socketAuthMiddleware = require("./middleware/socketAuthMiddleware");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

app.use(helmet());

app.use(
  cors({
    origin: CLIENT_URL,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "100kb" }));
app.use(morgan("dev"));

const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
  },
});

app.set("io", io);

// Authenticate every Socket.IO connection.
io.use(socketAuthMiddleware);

app.get("/", (req, res) => {
  res.status(200).json({
    message: "Welcome to SyncSpace API",
    status: "Running",
  });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "SyncSpace Backend",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/rooms", roomRoutes);

io.on("connection", (socket) => {
  console.log(
    `Authenticated user connected: ${socket.user.name} (${socket.id})`
  );

  socket.emit("connection:success", {
    message: "Authenticated connection established.",
    user: socket.user,
  });

  // A client can join only a room where they are an owner or member.
  socket.on("room:join", async (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};

    try {
      const roomId =
        payload && typeof payload.roomId === "string"
          ? payload.roomId.trim()
          : "";

      if (!roomId) {
        return reply({
          success: false,
          message: "A valid roomId is required.",
        });
      }

      const room = await prisma.room.findFirst({
        where: {
          id: roomId,
          OR: [
            {
              ownerId: socket.user.id,
            },
            {
              members: {
                some: {
                  userId: socket.user.id,
                },
              },
            },
          ],
        },
        select: {
          id: true,
          name: true,
          ownerId: true,
          members: {
            select: {
              userId: true,
              user: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
      });

      if (!room) {
        return reply({
          success: false,
          message: "Room not found or you are not a member.",
        });
      }

      const socketRoom = `room:${room.id}`;

      await socket.join(socketRoom);

      const participants = await io
        .in(socketRoom)
        .fetchSockets();

      const uniqueUsers = new Map();

      for (const participant of participants) {
        if (participant.user) {
          uniqueUsers.set(participant.user.id, {
            id: participant.user.id,
            name: participant.user.name,
          });
        }
      }

      reply({
        success: true,
        message: "Joined room successfully.",
        room: {
          id: room.id,
          name: room.name,
        },
        participants: Array.from(uniqueUsers.values()),
      });

      // Notify other room members that this user is online.
      socket.to(socketRoom).emit("room:participant-joined", {
        user: {
          id: socket.user.id,
          name: socket.user.name,
        },
        roomId: room.id,
      });

      console.log(
        `${socket.user.name} joined Socket.IO room ${room.id}`
      );
    } catch (error) {
      console.error("Socket room join error:", error.message);

      reply({
        success: false,
        message: "Unable to join room.",
      });
    }
  });

  socket.on("room:leave", async (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};

    try {
      const roomId =
        payload && typeof payload.roomId === "string"
          ? payload.roomId.trim()
          : "";

      if (!roomId) {
        return reply({
          success: false,
          message: "A valid roomId is required.",
        });
      }

      const socketRoom = `room:${roomId}`;

      if (!socket.rooms.has(socketRoom)) {
        return reply({
          success: false,
          message: "You have not joined this room.",
        });
      }

      await socket.leave(socketRoom);

      reply({
        success: true,
        message: "Left room successfully.",
        roomId,
      });

      socket.to(socketRoom).emit("room:participant-left", {
        user: {
          id: socket.user.id,
          name: socket.user.name,
        },
        roomId,
      });
    } catch (error) {
      console.error("Socket room leave error:", error.message);

      reply({
        success: false,
        message: "Unable to leave room.",
      });
    }
  });

  socket.on("disconnecting", () => {
    for (const roomName of socket.rooms) {
      if (roomName.startsWith("room:")) {
        socket.to(roomName).emit("room:participant-left", {
          user: {
            id: socket.user.id,
            name: socket.user.name,
          },
          roomId: roomName.slice("room:".length),
        });
      }
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(
      `User disconnected: ${socket.user.name} (${socket.id}) - ${reason}`
    );
  });
});

app.use((req, res) => {
  res.status(404).json({
    message: "Route not found.",
  });
});

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
