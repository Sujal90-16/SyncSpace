const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

async function socketAuthMiddleware(socket, next) {
  try {
    const token = socket.handshake.auth?.token;

    if (!token || typeof token !== "string") {
      return next(new Error("Authentication required."));
    }

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET is missing.");
      return next(new Error("Authentication service unavailable."));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.sub || decoded.id;

    if (!userId || typeof userId !== "string") {
      return next(new Error("Invalid authentication token."));
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });

    if (!user) {
      return next(new Error("User account not found."));
    }

    socket.user = user;

    return next();
  } catch (error) {
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError" ||
      error.name === "NotBeforeError"
    ) {
      return next(new Error("Invalid or expired authentication token."));
    }

    console.error("Socket authentication error:", error.message);

    return next(new Error("Socket authentication failed."));
  }
}

module.exports = socketAuthMiddleware;
