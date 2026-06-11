const { emailRegex } = require("../../utils/constants/regex");

module.exports = (req, res, next) => {
  const { userName, email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ status: false, message: "All fields are required" });
  }

  if (!emailRegex.test(email)) {
    return res
      .status(400)
      .json({ status: false, message: "Invalid email format" });
  }

  next();
};
