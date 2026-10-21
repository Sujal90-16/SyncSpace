const crypto = require("crypto");
const prisma = require("../config/prisma");

async function generateRoomCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const roomCode = crypto.randomBytes(4).toString("hex").toUpperCase();

    const existingRoom = await prisma.room.findUnique({
      where: { roomCode },
    });

    if (!existingRoom) {
      return roomCode;
    }
  }

  throw new Error("Unable to generate a unique room code.");
}

// POST /api/rooms
exports.createRoom = async (req, res) => {
  try {
    const { name, description } = req.body || {};

    if (
      typeof name !== "string" ||
      name.trim().length < 2 ||
      name.trim().length > 80
    ) {
      return res.status(400).json({
        message: "Room name must be between 2 and 80 characters.",
      });
    }

    if (
      description !== undefined &&
      description !== null &&
      (typeof description !== "string" ||
        description.trim().length > 500)
    ) {
      return res.status(400).json({
        message: "Description must be a string with at most 500 characters.",
      });
    }

    const roomCode = await generateRoomCode();

    const room = await prisma.$transaction(async (tx) => {
      const createdRoom = await tx.room.create({
        data: {
          name: name.trim(),
          description:
            typeof description === "string" && description.trim()
              ? description.trim()
              : null,
          roomCode,
          ownerId: req.user.id,
        },
      });

      await tx.roomMember.create({
        data: {
          userId: req.user.id,
          roomId: createdRoom.id,
          role: "OWNER",
        },
      });

      return createdRoom;
    });

    return res.status(201).json({
      message: "Room created successfully.",
      room,
    });
  } catch (error) {
    console.error("Create room error:", error.message);

    if (error.code === "P2002") {
      return res.status(409).json({
        message: "Room code conflict. Please try again.",
      });
    }

    return res.status(500).json({
      message: "Unable to create room.",
    });
  }
};

// POST /api/rooms/join
exports.joinRoom = async (req, res) => {
  try {
    const { roomCode } = req.body || {};

    if (typeof roomCode !== "string" || !roomCode.trim()) {
      return res.status(400).json({
        message: "Please provide a valid room code.",
      });
    }

    const normalizedCode = roomCode.trim().toUpperCase();

    const room = await prisma.room.findUnique({
      where: {
        roomCode: normalizedCode,
      },
    });

    if (!room) {
      return res.status(404).json({
        message: "Room not found. Please check the room code.",
      });
    }

    const existingMembership = await prisma.roomMember.findUnique({
      where: {
        userId_roomId: {
          userId: req.user.id,
          roomId: room.id,
        },
      },
    });

    if (existingMembership) {
      return res.status(200).json({
        message: "You are already a member of this room.",
        alreadyMember: true,
        room,
      });
    }

    await prisma.roomMember.create({
      data: {
        userId: req.user.id,
        roomId: room.id,
        role: "MEMBER",
      },
    });

    return res.status(200).json({
      message: "Joined room successfully.",
      alreadyMember: false,
      room,
    });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(200).json({
        message: "You are already a member of this room.",
        alreadyMember: true,
      });
    }

    console.error("Join room error:", error.message);

    return res.status(500).json({
      message: "Unable to join room.",
    });
  }
};

// GET /api/rooms
exports.getMyRooms = async (req, res) => {
  try {
    const rooms = await prisma.room.findMany({
      where: {
        OR: [
          {
            ownerId: req.user.id,
          },
          {
            members: {
              some: {
                userId: req.user.id,
              },
            },
          },
        ],
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        name: true,
        description: true,
        roomCode: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
        owner: {
          select: {
            id: true,
            name: true,
          },
        },
        members: {
          where: {
            userId: req.user.id,
          },
          select: {
            role: true,
            joinedAt: true,
          },
        },
      },
    });

    return res.status(200).json({
      count: rooms.length,
      rooms,
    });
  } catch (error) {
    console.error("Get rooms error:", error.message);

    return res.status(500).json({
      message: "Unable to fetch your rooms.",
    });
  }
};
