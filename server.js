require("dotenv").config();

const express = require("express");

const voiceRoutes = require("./routes/voice");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use("/voice", voiceRoutes);

app.get("/", (req, res) => {
    res.send("Creative Coatings AI Receptionist is running.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
