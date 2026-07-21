/**
 * Bootstrap / promote an admin account for the fuel-admin console.
 *
 * Usage (from fuel-api root):
 *   npm run create-admin -- admin@example.com 'a-strong-password'
 *
 * - Creates the user if the email is new (hashed password), role = "admin".
 * - If the user already exists, promotes them to admin. Pass a password to also
 *   reset it; omit it to keep the existing password.
 *
 * This is the one-off way to mint the first admin, since /api/admin/* requires an
 * existing admin. Run once, then manage further admins from the console (PATCH
 * /api/admin/users/:id role).
 */
import { prisma } from "../db";
import { hashPassword } from "../services/auth";

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email) {
    console.error("Usage: npm run create-admin -- <email> [password]");
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        role: "admin",
        ...(password ? { hashedPassword: await hashPassword(password) } : {}),
      },
    });
    console.log(`✓ Promoted existing user ${email} to admin${password ? " (password reset)" : ""}.`);
  } else {
    if (!password) {
      console.error("A password is required when creating a new admin user.");
      process.exit(1);
    }
    const user = await prisma.user.create({
      data: { email, hashedPassword: await hashPassword(password), role: "admin" },
    });
    console.log(`✓ Created admin user ${email} (id ${user.id}).`);
  }
}

main()
  .catch((err) => {
    console.error("Failed to create admin:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
