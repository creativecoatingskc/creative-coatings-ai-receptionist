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

const TWILIO_PHONE_NUMBER =
  process.env.TWILIO_PHONE_NUMBER || "+18165459727";

const AFTER_HOURS_NOTIFICATION_NUMBER = "+19132120955";

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

/**
 * Creative Coatings hours in America/Chicago:
 * Monday-Thursday: 7:00 AM-4:30 PM
 * Friday: 7:00 AM-12:00 PM
 * Saturday-Sunday: Closed
 */
function getBusinessHoursStatus() {
  const now = new Date();

  const centralTimeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);

  const values = {};

  for (const part of centralTimeParts) {
    values[part.type] = part.value;
  }

  const weekday = values.weekday;
  const hour = Number(values.hour);
  const minute = Number(values.minute);

  const currentMinutes = hour * 60 + minute;
  const openingMinutes = 7 * 60;

  let closingMinutes = null;

  if (
    weekday === "Monday" ||
    weekday === "Tuesday" ||
    weekday === "Wednesday" ||
    weekday === "Thursday"
  ) {
    closingMinutes = 16 * 60 + 30;
  }

  if (weekday === "Friday") {
    closingMinutes = 12 * 60;
  }

  const isBusinessDay = closingMinutes !== null;

  const isOpen =
    isBusinessDay &&
    currentMinutes >= openingMinutes &&
    currentMinutes < closingMinutes;

  return {
    isOpen,
    weekday,
    currentMinutes,
    openingMinutes,
    closingMinutes
  };
}

const mediaStreamServer = new WebSocket.Server({
  server,
  path: "/media-stream"
});

mediaStreamServer.on("connection", (twilioSocket) => {
  console.log("Twilio media stream connected.");

  let streamSid = null;
  let callSid = null;
  let transferStarted = false;
  let messageSubmitted = false;

  let openAiConnected = false;
  let sessionConfigured = false;
  let greetingRequested = false;
  let greetingFinished = false;
  let acceptingCallerAudio = false;

  const hoursStatus = getBusinessHoursStatus();
  const isBusinessHours = hoursStatus.isOpen;

  console.log(
    `Call mode: ${
      isBusinessHours ? "BUSINESS HOURS" : "AFTER HOURS"
    } — ${hoursStatus.weekday}`
  );

  const openAiSocket = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );

  async function transferCall(department) {
    if (!isBusinessHours) {
      throw new Error("Transfers are disabled outside business hours.");
    }

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
      "It looks like no one is available right now. Please call back during business hours, or leave a message with our receptionist."
    );

    await twilioClient.calls(callSid).update({
      twiml: response.toString()
    });

    console.log(`Transferred call to ${department}: ${phoneNumber}`);
  }

  async function submitAfterHoursMessage(details) {
    if (messageSubmitted) {
      return {
        success: true,
        duplicatePrevented: true
      };
    }

    messageSubmitted = true;

    let originatingNumber = "Not available";

    if (callSid) {
      try {
        const call = await twilioClient.calls(callSid).fetch();

        if (call.from) {
          originatingNumber = call.from;
        }
      } catch (error) {
        console.error(
          "Could not retrieve originating caller number:",
          error.message
        );
      }
    }

    const name = details.name || "Not provided";

    const callbackNumber =
      details.callback_number ||
      originatingNumber ||
      "Not provided";

    const company = details.company || "Not provided";
    const requestedPerson = details.requested_person || "Not specified";
    const department = details.department || "Not specified";
    const projectDetails = details.project_details || "Not provided";
    const message = details.message || "No additional message provided";

    const body = [
      "New After-Hours Call",
      "",
      `Name: ${name}`,
      `Callback: ${callbackNumber}`,
      `Incoming number: ${originatingNumber}`,
      `Company: ${company}`,
      `Person requested: ${requestedPerson}`,
      `Department: ${department}`,
      `Project: ${projectDetails}`,
      "",
      `Message: ${message}`
    ].join("\n");

    await twilioClient.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: AFTER_HOURS_NOTIFICATION_NUMBER,
      body
    });

    console.log(
      `After-hours message texted to ${AFTER_HOURS_NOTIFICATION_NUMBER}`
    );

    return {
      success: true
    };
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

    const businessHoursInstructions = `
You are the phone receptionist for Creative Coatings in Platte City, Missouri.

The business is currently open.

You are friendly, professional, patient, natural, and concise.

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

WRAP, TINT, AND SIGNAGE

Transfer to sales when the caller asks about:

- Bryan
- Sales
- Wraps or vehicle graphics
- Window tint
- Signage
- Banners
- Decals or stickers
- Paint protection film or PPF
- Pricing or quotes for those services

Say:

"Absolutely. I'll connect you with Bryan, who handles our wraps, tint, and signage quotes."

Then use transfer_call with department set to sales.

APPAREL

Transfer to apparel when the caller asks about:

- Linda
- Apparel
- Shirts
- Hats
- Embroidery
- Uniforms
- Clothing
- Apparel quotes or questions
- An existing apparel order

Say:

"Certainly. I'll connect you with Linda in our apparel department."

Then use transfer_call with department set to apparel.

JOB STATUS

Transfer to sales when the caller asks:

- For a job status update
- Whether their project is finished
- Whether their order is ready
- When their project will be completed
- For progress information on an existing project

Say:

"Absolutely. I'll connect you with Bryan for a job status update."

Then use transfer_call with department set to sales.

DESIGN

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

Say:

"Certainly. I'll connect you with Jen in our design department."

Then use transfer_call with department set to design.

EMPLOYEE ROUTING

Linda means apparel.
Bryan means sales.
Jen means design.

When the destination is clear, do not ask unnecessary follow-up questions.

Do not say you cannot transfer callers.

Do not claim a transfer is complete until you use the transfer_call tool.

Do not invent prices.

Do not promise exact completion dates.

Do not say a project is complete unless it has been verified.

Do not disclose private customer information.
    `.trim();

    const afterHoursInstructions = `
You are the after-hours phone receptionist for Creative Coatings in Platte City, Missouri.

The business is currently closed.

Creative Coatings is open:

- Monday through Thursday from 7:00 AM until 4:30 PM Central Time.
- Friday from 7:00 AM until 12:00 PM Central Time.
- Closed Saturday and Sunday.

You are friendly, professional, patient, natural, and concise.

The phone system provides the opening greeting separately.

Never repeat or restart the opening greeting.

After the greeting, wait silently for the caller to answer.

Do not respond to breathing, coughing, fans, vehicle noise, music, paper movement, or other unclear background sounds.

Only respond when the caller makes a clear request.

Do not interrupt or talk over the caller.

AFTER-HOURS RULES

Never transfer an after-hours call.

Do not offer to transfer the caller.

Do not ring Linda, Bryan, Jen, or any employee.

Explain that the office is closed and that you can take a message.

Collect the following information conversationally, one item at a time:

1. The caller's full name
2. The best callback phone number
3. Their company name, if applicable
4. Who or which department they were trying to reach
5. What service or project they are calling about
6. A clear message describing what they need

Do not make the caller repeat information they already provided.

If the caller's incoming phone number can be used as the callback number, ask them to confirm it.

Before submitting, briefly summarize the message and ask:

"Is that information correct?"

Only after the caller confirms the information is correct, use the submit_after_hours_message tool.

Pass every collected detail into the tool.

After the tool reports success, say:

"Thank you. I've sent your message to the Creative Coatings team. Someone will follow up with you during business hours."

Do not claim the message was sent until the tool succeeds.

Do not invent prices.

Do not promise when someone will call back.

Do not promise an exact project completion date.

Do not disclose private customer or project information.
    `.trim();

    const tools = isBusinessHours
      ? [
          {
            type: "function",
            name: "transfer_call",
            description:
              "Transfer the active caller to the correct Creative Coatings employee or department during business hours.",
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
        ]
      : [
          {
            type: "function",
            name: "submit_after_hours_message",
            description:
              "Text a completed and caller-confirmed after-hours message to the Creative Coatings team.",
            parameters: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The caller's full name."
                },
                callback_number: {
                  type: "string",
                  description:
                    "The best phone number for returning the caller's call."
                },
                company: {
                  type: "string",
                  description:
                    "The caller's company name, or Not applicable."
                },
                requested_person: {
                  type: "string",
                  description:
                    "The employee the caller requested, such as Bryan, Linda, or Jen, or Not specified."
                },
                department: {
                  type: "string",
                  description:
                    "The requested department or service category."
                },
                project_details: {
                  type: "string",
                  description:
                    "Vehicle, apparel, signage, design, or other project details."
                },
                message: {
                  type: "string",
                  description:
                    "A concise but complete description of what the caller needs."
                }
              },
              required: [
                "name",
                "callback_number",
                "company",
                "requested_person",
                "department",
                "project_details",
                "message"
              ]
            }
          }
        ];

    openAiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          output_modalities: ["audio"],

          instructions: isBusinessHours
            ? businessHoursInstructions
            : afterHoursInstructions,

          tools,
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

    const businessHoursGreeting = `
Say exactly this greeting once:

"Thank you for calling Creative Coatings. Are you calling about a wrap, tint, or signage quote; apparel quotes or questions; a job status update; or design questions? If you know the name of the person you're trying to reach, you can say it now."

Do not add anything before or after it.

After saying it, stop speaking and wait silently for the caller.
    `.trim();

    const afterHoursGreeting = `
Say exactly this greeting once:

"Thank you for calling Creative Coatings. Our office is currently closed, but I'd be happy to take a message for our team. May I start with your name?"

Do not add anything before or after it.

After saying it, stop speaking and wait silently for the caller.
    `.trim();

    openAiSocket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions: isBusinessHours
            ? businessHoursGreeting
            : afterHoursGreeting
        }
      })
    );

    console.log(
      `${
        isBusinessHours ? "Business-hours" : "After-hours"
      } greeting requested.`
    );
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

      if (
        event.type === "response.function_call_arguments.done" &&
        event.name === "submit_after_hours_message"
      ) {
        const details = JSON.parse(event.arguments || "{}");

        console.log("After-hours message requested:", details);

        try {
          const result = await submitAfterHoursMessage(details);

          if (openAiSocket.readyState === WebSocket.OPEN) {
            openAiSocket.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: event.call_id,
                  output: JSON.stringify(result)
                }
              })
            );

            openAiSocket.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  instructions:
                    "Confirm that the message was sent successfully. Thank the caller and explain that someone will follow up during business hours. Do not ask any more questions."
                }
              })
            );
          }
        } catch (error) {
          messageSubmitted = false;

          console.error(
            "After-hours message failed:",
            error.message
          );

          if (openAiSocket.readyState === WebSocket.OPEN) {
            openAiSocket.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: event.call_id,
                  output: JSON.stringify({
                    success: false,
                    error: "The message could not be sent."
                  })
                }
              })
            );

            openAiSocket.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  instructions:
                    "Apologize and explain that the message could not be delivered. Ask the caller to call back during business hours. Do not claim that the message was sent."
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