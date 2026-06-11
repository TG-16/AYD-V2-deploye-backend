const { emailRegex, passwordRegex } = require("../../utils/constants/regex");

const reseEmailValidator = (req, res, next) => {
  const { email } = req.body;

  if (!email) {
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

const resetPasswordValidator = (req, res, next) => {
  const { newPassword } = req.body;
  const token = req.query.token || req.body.token;

  if (!token || !newPassword) {
    return res
      .status(400)
      .json({ status: false, message: "All fields are required" });
  }

  if (!passwordRegex.test(newPassword)) {
    return res.status(400).json({
      status: false,
      message:
        "Password must be at least 8 characters long and contain both letters and numbers",
    });
  }

  next();
};

module.exports = {
  reseEmailValidator,
  resetPasswordValidator,
};
