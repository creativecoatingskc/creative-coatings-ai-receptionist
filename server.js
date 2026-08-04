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

  let openAiConnected = false;
  let sessionConfigured = false;
  let greetingRequested = false;
  let greetingFinished = false;
  let acceptingCallerAudio = false;

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
    acceptingCallerAudio = false;

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
      "No one was available to answer. Please call back during business hours, and a Creative Coatings team member will be happy to help."
    );

    await twilioClient.calls(callSid).update({
      twiml: response.toString()
    });

    console.log(`Transferred call to ${department}: ${phoneNumber}`);
  }

  function configureSession() {
    if (
      !openAiConnected ||
      sessionConfigured ||
      openAiSocket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    sessionConfigured = true;

    openAiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          output_modalities: ["audio"],

          instructions: `
You are the phone receptionist for Creative Coatings in Platte City, Missouri.

You are friendly, professional, patient, natural, and concise.

OPENING GREETING

The phone system provides the opening greeting separately.

Never repeat or restart the opening greeting.

After the greeting, wait silently for the caller to answer.

Do not respond to breathing, coughing, fans, vehicle noise, music, paper movement, or other unclear background sounds.

Only respond when the caller makes a clear request.

Do not interrupt or talk over the caller.

If you cannot understand the caller, say only:

"I'm sorry, I didn't quite catch that. Are you calling about a quote, apparel, a job status update, or design?"

CALL OPTIONS

The caller may be calling about:

1. A wrap, tint, or signage quote
2. Apparel quotes or questions
3. A job status update
4. Design questions

The caller may also ask for Linda, Bryan, or Jen by name.

WRAP, TINT, AND SIGNAGE ROUTING

Transfer to sales when the caller asks about:

- Bryan
- Sales
- A wrap quote
- Commercial vehicle wraps
- Color-change wraps
- Window tint
- Signage
- Banners
- Decals
- Stickers
- Paint protection film or PPF
- Vehicle services
- Pricing for wraps, tint, signage, decals, banners, or PPF

Before transferring, say:

"Absolutely. I'll connect you with Bryan, who handles our wraps, tint, and signage quotes."

Then use transfer_call with department set to sales.

APPAREL ROUTING

Transfer to apparel when the caller asks about:

- Linda
- Apparel
- Apparel quotes
- Shirts
- Hats
- Embroidery
- Uniforms
- Clothing
- An existing apparel order
- General apparel questions

Before transferring, say:

"Certainly. I'll connect you with Linda in our apparel department."

Then use transfer_call with department set to apparel.

JOB STATUS ROUTING

Transfer to sales when the caller:

- Wants a job status update
- Asks whether a project is finished
- Asks whether an order is ready
- Asks when a project will be completed
- Wants progress information about an existing project

Before transferring, say:

"Absolutely. I'll connect you with Bryan for a job status update."

Then use transfer_call with department set to sales.

DESIGN ROUTING

Transfer to design when the caller asks about:

- Jen
- The design department
- Artwork
- Proofs
- Revisions
- Logos
- Colors
- Layouts
- Submitting artwork
- Design changes

Before transferring, say:

"Certainly. I'll connect you with Jen in our design department."

Then use transfer_call with department set to design.

EMPLOYEE NAME ROUTING

Linda means apparel.

Bryan means sales.

Jen means design.

When the destination is clear, do not ask unnecessary follow-up questions.

Do not tell callers you cannot transfer them.

Do not claim the transfer is complete until the transfer tool has been used.

UNCLEAR ANSWERS

If the caller's answer is unclear, ask only:

"Are you calling about a wrap, tint, or signage quote; apparel; a job status update; or design?"

Do not repeat the entire original greeting.

GENERAL RULES

Do not invent prices.

Do not promise exact completion dates.

Do not say a project is complete unless its status has been verified.

Do not disclose private customer information.

If you do not know an answer, say:

"A Creative Coatings team member will need to confirm that for you."

Then offer the appropriate transfer.
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
                      "The Creative Coatings department that should receive the call."
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

              noise_reduction: {
                type: "far_field"
              },

              turn_detection: {
                type: "server_vad",
                threshold: 0.75,
                prefix_padding_ms: 400,
                silence_duration_ms: 1000,
                create_response: true,
                interrupt_response: false
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
  }

  function requestOpeningGreeting() {
    if (
      greetingRequested ||
      !sessionConfigured ||
      !streamSid ||
      openAiSocket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    greetingRequested = true;
    acceptingCallerAudio = false;

    openAiSocket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions: `
Say exactly this greeting once:

"Thank you for calling Creative Coatings. Are you calling about a wrap, tint, or signage quote; apparel quotes or questions; a job status update; or design questions? If you know the name of the person you're trying to reach, you can say it now."

Do not add anything before or after the greeting.

After saying it, stop speaking and wait silently for the caller.
          `.trim()
        }
      })
    );

    console.log("Opening greeting requested.");
  }

  openAiSocket.on("open", () => {
    console.log("Connected to OpenAI Realtime.");
    openAiConnected = true;
    configureSession();
  });

  twilioSocket.on("message", (message) => {
    try {
      const event = JSON.parse(message.toString());

      if (event.event === "start") {
        streamSid = event.start.streamSid;
        callSid = event.start.callSid;

        console.log("Twilio stream started:", streamSid);
        console.log("Twilio call SID:", callSid);

        requestOpeningGreeting();
        return;
      }

      if (
        event.event === "media" &&
        acceptingCallerAudio &&
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

      if (event.type === "session.updated") {
        console.log("OpenAI session updated.");
        requestOpeningGreeting();
      }

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

      /*
       * The first completed response is the greeting.
       * Caller audio is ignored until the greeting has finished.
       */
      if (
        event.type === "response.done" &&
        greetingRequested &&
        !greetingFinished
      ) {
        greetingFinished = true;

        setTimeout(() => {
          acceptingCallerAudio = true;
          console.log("Greeting finished. Listening to caller.");
        }, 350);
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
          acceptingCallerAudio = true;

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
                    "Apologize briefly and offer to take a message. Do not repeat the opening greeting."
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