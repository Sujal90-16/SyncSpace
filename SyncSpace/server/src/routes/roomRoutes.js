const express = require("express");
const roomController = require("../controllers/roomController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

router.use(authMiddleware);

router.post("/", roomController.createRoom);
router.post("/join", roomController.joinRoom);
router.get("/", roomController.getMyRooms);

module.exports = router;
