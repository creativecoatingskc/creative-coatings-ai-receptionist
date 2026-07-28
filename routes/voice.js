const express = require("express");

const router = express.Router();

router.post("/", (req, res) => {
  res.type("text/xml");

  res.send(`
<Response>
  <Say voice="alice">
    Welcome to Creative Coatings.
    Our AI receptionist is currently under construction.
    Please call back soon.
  </Say>
</Response>
  `);
});

module.exports = router;