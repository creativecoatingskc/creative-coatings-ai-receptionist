const express = require("express");
const twilio = require("twilio");

const router = express.Router();

router.post("/", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const connect = twiml.connect();
  connect.stream({
    url: "wss://creative-coatings-ai-receptionist.onrender.com/media-stream"
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

module.exports = router;