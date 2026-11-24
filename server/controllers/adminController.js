export const getCurrentAdmin = (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      userId: req.user.userId,
      role: req.user.role,
    },
  });
};
