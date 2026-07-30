require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const voiceRoutes = require("./routes/voice");

const app = express();
const server = http.createServer(app);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use("/voice", voiceRoutes);

app.get("/", (req, res) => {
  res.send("Creative Coatings AI Receptionist is running.");
});

const mediaStreamServer = new WebSocket.Server({
  server,
  path: "/media-stream"
});

mediaStreamServer.on("connection", (twilioSocket) => {
  console.log("Twilio media stream connected.");

  let streamSid = null;

  const openAiSocket = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );

  openAiSocket.on("open", () => {
    console.log("Connected to OpenAI Realtime.");

    openAiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          output_modalities: ["audio"],
          instructions: `
You are the phone receptionist for Creative Coatings in Platte City, Missouri.

Be warm, natural, helpful, and concise.

Start every call by saying:
"Thank you for calling Creative Coatings. How can I help you today?"

Creative Coatings provides:
- Commercial vehicle wraps and decals
- Color change vehicle wraps
- Window tint
- Paint protection film
- Signs, banners, stickers, and decals
- Custom apparel and embroidery

Do not invent pricing or promise an exact completion date.
Ask useful follow-up questions and collect the caller's:
- Name
- Phone number
- Vehicle or project details
- Desired service

If you do not know an answer, explain that a Creative Coatings team member will follow up.
          `.trim(),
          audio: {
            input: {
              format: {
                type: "audio/pcmu"
              },
              turn_detection: {
                type: "server_vad",
                create_response: true,
                interrupt_response: true,
                silence_duration_ms: 500
              }
            },
            output: {
              format: {
                type: "audio/pcmu"
              },
              voice: "marin"
            }
          }
        }
      })
    );

    openAiSocket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Greet the caller now using the required Creative Coatings greeting."
        }
      })
    );
  });

  twilioSocket.on("message", (message) => {
    const event = JSON.parse(message.toString());

    if (event.event === "start") {
      streamSid = event.start.streamSid;
      console.log("Twilio stream started:", streamSid);
      return;
    }

    if (
      event.event === "media" &&
      openAiSocket.readyState === WebSocket.OPEN
    ) {
      openAiSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: event.media.payload
        })
      );
    }

    if (event.event === "stop") {
      console.log("Twilio stream stopped.");
      openAiSocket.close();
    }
  });

  openAiSocket.on("message", (message) => {
    const event = JSON.parse(message.toString());

    if (
      event.type === "response.output_audio.delta" &&
      event.delta &&
      streamSid
    ) {
      twilioSocket.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: event.delta
          }
        })
      );
    }

    if (event.type === "error") {
      console.error("OpenAI Realtime error:", event.error);
    }
  });

  openAiSocket.on("close", () => {
    console.log("OpenAI Realtime disconnected.");

    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.close();
    }
  });

  openAiSocket.on("error", (error) => {
    console.error("OpenAI WebSocket error:", error.message);
  });

  twilioSocket.on("close", () => {
    console.log("Twilio media stream disconnected.");

    if (openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });

  twilioSocket.on("error", (error) => {
    console.error("Twilio WebSocket error:", error.message);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});