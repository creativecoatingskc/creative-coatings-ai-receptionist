require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");

const voiceRoutes = require("./routes/voice");

const app = express();
const server = http.createServer(app);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TRANSFER_NUMBERS = {
  apparel: "+18164316744",
  sales: "+18167088758",
  design: "+18168010002"
};

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
  let callSid = null;
  let transferStarted = false;

  const openAiSocket = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );

  async function transferCall(department) {
    if (transferStarted) {
      return;
    }

    const phoneNumber = TRANSFER_NUMBERS[department];

    if (!phoneNumber || !callSid) {
      throw new Error("Missing transfer number or Twilio Call SID.");
    }

    transferStarted = true;

    const departmentNames = {
      apparel: "Linda and the apparel department",
      sales: "Bryan and the sales team",
      design: "Jen and the design department"
    };

    const response = new twilio.twiml.VoiceResponse();

    response.say(
      { voice: "alice" },
      `Please hold while I connect you with ${departmentNames[department]}.`
    );

    const dial = response.dial({
      answerOnBridge: true,
      timeout: 25
    });

    dial.number(phoneNumber);

    response.say(
      { voice: "alice" },
      "No one was available to answer. A Creative Coatings team member will follow up with you as soon as possible."
    );

    await twilioClient.calls(callSid).update({
      twiml: response.toString()
    });

    console.log(`Transferred call to ${department}: ${phoneNumber}`);
  }

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

CALL TRANSFERS:

Transfer to apparel when the caller:
- Asks for Linda
- Asks for apparel, shirts, embroidery, hats, or clothing

Transfer to sales when the caller:
- Asks for Bryan
- Asks for sales
- Wants wraps, window tint, signage, decals, banners, PPF, or vehicle services
- Asks to speak directly with someone about a quote

Transfer to design when the caller:
- Asks for Jen
- Asks for the design department
- Needs help with artwork, proofs, revisions, or design questions

Before transferring, briefly confirm where you are sending the caller.
Then use the transfer_call tool.

Do not claim that you cannot connect callers to an employee.

Do not invent pricing or promise an exact completion date.

Ask useful follow-up questions and collect the caller's:
- Name
- Phone number
- Vehicle or project details
- Desired service

If the caller does not want a transfer, continue helping them normally.
          `.trim(),

          tools: [
            {
              type: "function",
              name: "transfer_call",
              description:
                "Transfer the active caller to the correct Creative Coatings employee or department.",
              parameters: {
                type: "object",
                properties: {
                  department: {
                    type: "string",
                    enum: ["apparel", "sales", "design"],
                    description:
                      "The department that should receive the call."
                  }
                },
                required: ["department"]
              }
            }
          ],

          tool_choice: "auto",

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
    try {
      const event = JSON.parse(message.toString());

      if (event.event === "start") {
        streamSid = event.start.streamSid;
        callSid = event.start.callSid;

        console.log("Twilio stream started:", streamSid);
        console.log("Twilio call SID:", callSid);
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

        if (openAiSocket.readyState === WebSocket.OPEN) {
          openAiSocket.close();
        }
      }
    } catch (error) {
      console.error("Twilio message error:", error.message);
    }
  });

  openAiSocket.on("message", async (message) => {
    try {
      const event = JSON.parse(message.toString());

      if (
        event.type === "response.output_audio.delta" &&
        event.delta &&
        streamSid &&
        twilioSocket.readyState === WebSocket.OPEN
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

      if (
        event.type === "response.function_call_arguments.done" &&
        event.name === "transfer_call"
      ) {
        const argumentsObject = JSON.parse(event.arguments || "{}");
        const department = argumentsObject.department;

        console.log("Transfer requested:", department);

        try {
          await transferCall(department);
        } catch (error) {
          transferStarted = false;
          console.error("Transfer failed:", error.message);

          if (openAiSocket.readyState === WebSocket.OPEN) {
            openAiSocket.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: event.call_id,
                  output: JSON.stringify({
                    success: false,
                    error: "The transfer could not be completed."
                  })
                }
              })
            );

            openAiSocket.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  instructions:
                    "Apologize briefly and offer to take a message for the team."
                }
              })
            );
          }
        }
      }

      if (event.type === "error") {
        console.error("OpenAI Realtime error:", event.error);
      }
    } catch (error) {
      console.error("OpenAI message error:", error.message);
    }
  });

  openAiSocket.on("close", () => {
    console.log("OpenAI Realtime disconnected.");

    if (
      !transferStarted &&
      twilioSocket.readyState === WebSocket.OPEN
    ) {
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