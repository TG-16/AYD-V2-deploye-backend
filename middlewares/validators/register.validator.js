const { emailRegex, passwordRegex } = require("../../utils/constants/regex");

module.exports = (req, res, next) => {
  const { userName, email, password } = req.body;

  if (!userName || !email || !password) {
    return res
      .status(400)
      .json({ status: false, message: "All fields are required" });
  }

  if (typeof userName !== "string") {
    return res
      .status(400)
      .json({ status: false, message: "Username must be a string" });
  }

  if (!emailRegex.test(email)) {
    return res
      .status(400)
      .json({ status: false, message: "Invalid email format" });
  }

  if (!passwordRegex.test(password)) {
    return res
      .status(400)
      .json({
        status: false,
        message:
          "Password must be at least 8 characters long and contain both letters and numbers",
      });
  }

  next();
};
