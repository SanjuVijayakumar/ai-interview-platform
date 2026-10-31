import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

// Register new user
export const registerUser = async (req, res) => {
try {
const { name, email, password } = req.body;


// Validate required fields
if (!name || !email || !password) {
  return res.status(400).json({
    success: false,
    message: "Name, email, and password are required",
  });
}

// Validate password length
if (password.length < 6) {
  return res.status(400).json({
    success: false,
    message: "Password must be at least 6 characters long",
  });
}

// Normalize the email
const normalizedEmail = email.trim().toLowerCase();

// Check whether the email already exists
const existingUser = await User.findOne({
  email: normalizedEmail,
});

if (existingUser) {
  return res.status(409).json({
    success: false,
    message: "An account with this email already exists",
  });
}

// Hashing the password
const hashedPassword = await bcrypt.hash(password, 12);

// Create the user
const user = await User.create({
  name: name.trim(),
  email: normalizedEmail,
  password: hashedPassword,
});

// return safe user information
return res.status(201).json({
  success: true,
  message: "User registered successfully",
  user: {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
  },
});


} catch (error) {
// Handle duplicate email index errors
if (error.code === 11000) {
return res.status(409).json({
success: false,
message: "An account with this email already exists",
});
}


console.error("Registration error:", error.message);

return res.status(500).json({
  success: false,
  message: "Internal server error during registration",
});


}
};

// Login an existing user
export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Validate required fields
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // 2. Normalize the email
    const normalizedEmail = email.trim().toLowerCase();

    // 3. Find the user and explicitly include the password hash
    const user = await User.findOne({
      email: normalizedEmail,
    }).select("+password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // 4. Compare the submitted password with the stored hash
    const isPasswordValid = await bcrypt.compare(
      password,
      user.password
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // 5. Generate a JWT token
    const token = jwt.sign(
      {
        userId: user._id.toString(),
        role: user.role,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN || "1d",
      }
    );

    // 6. Return the token and safe user information
    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Internal server error during login",
    });
  }
};

// Update authenticated user's profile
export const updateUserProfile = async (req, res) => {
  try {
    const { name, skills, experience, targetRole } = req.body;

    // to find the authenticated user
    const user = await User.findById(req.user.userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Check whether at least one field is provided
    if (
      name === undefined &&
      skills === undefined &&
      experience === undefined &&
      targetRole === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "At least one profile field is required",
      });
    }

    // Validate name
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Name must be a non-empty string",
        });
      }

      user.name = name.trim();
    }

    // Validate skills
    if (skills !== undefined) {
      if (
        !Array.isArray(skills) ||
        !skills.every(
          (skill) => typeof skill === "string" && skill.trim()
        )
      ) {
        return res.status(400).json({
          success: false,
          message: "Skills must be an array of non-empty strings",
        });
      }

      user.skills = skills.map((skill) => skill.trim());
    }

    // Validate experience
    if (experience !== undefined) {
      if (
        typeof experience !== "number" ||
        !Number.isFinite(experience) ||
        experience < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Experience must be a valid non-negative number",
        });
      }

      user.experience = experience;
    }

    // Validate target role
    if (targetRole !== undefined) {
      if (
        typeof targetRole !== "string" ||
        !targetRole.trim()
      ) {
        return res.status(400).json({
          success: false,
          message: "Target role must be a non-empty string",
        });
      }

      user.targetRole = targetRole.trim();
    }

    // Save updated profile
    await user.save();

    // Return safe user information
    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        skills: user.skills,
        experience: user.experience,
        targetRole: user.targetRole,
      },
    });
  } catch (error) {
    console.error("Profile update error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Internal server error while updating profile",
    });
  }
};