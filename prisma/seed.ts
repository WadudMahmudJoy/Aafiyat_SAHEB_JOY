import "dotenv/config";
import { prisma } from "../src/lib/prisma";

const initialCategories = [
  { name: "T-Shirt", slug: "t-shirts" },
  { name: "Half Shirt", slug: "half-shirts" },
  { name: "Full Shirt", slug: "full-shirts" },
  { name: "Panjabi", slug: "panjabi" },
  { name: "Sherwani", slug: "sherwani" },
];

async function main() {
  const target = new URL(process.env.DATABASE_URL!);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55432" ||
    target.pathname !== "/aafiyat_dev" ||
    target.username !== "aafiyat_dev" ||
    target.searchParams.get("schema") !== "public"
  ) {
    throw new Error("Category seeding is restricted to the existing local Aafiyat database.");
  }

  const [identity] = await prisma.$queryRaw<
    { database_name: string; schema_name: string; user_name: string }[]
  >`SELECT current_database() AS database_name, current_schema() AS schema_name, current_user AS user_name`;
  if (
    identity.database_name !== "aafiyat_dev" ||
    identity.schema_name !== "public" ||
    identity.user_name !== "aafiyat_dev"
  ) {
    throw new Error("Connected database identity does not match the local Aafiyat target.");
  }

  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.category.findMany({ orderBy: { slug: "asc" } });
    // PostgreSQL ON CONFLICT DO NOTHING: never update an existing category.
    const inserted = await tx.category.createMany({
      data: initialCategories.map((category, sortOrder) => ({ ...category, sortOrder })),
      skipDuplicates: true,
    });
    const after = await tx.category.findMany({ orderBy: { slug: "asc" } });

    for (const existing of before) {
      if (JSON.stringify(existing) !== JSON.stringify(after.find((row) => row.id === existing.id))) {
        throw new Error("An existing category changed during seeding.");
      }
    }
    for (const expected of initialCategories) {
      if (!after.some((row) => row.slug === expected.slug && row.name === expected.name)) {
        throw new Error("An initial category is missing or conflicts with an existing record.");
      }
    }
    if (before.length === 0 && after.length !== initialCategories.length) {
      throw new Error("Unexpected category count after initial seeding.");
    }

    return { created: inserted.count, existingUnchanged: before.length, categories: after };
  });

  console.log("Prisma connected to local aafiyat_dev/public.");
  console.log(`Categories created: ${result.created}; existing records unchanged: ${result.existingUnchanged}.`);
  console.table(result.categories.map(({ name, slug }) => ({ name, slug })));
}

main()
  .catch(() => {
    // Do not print driver errors or connection strings, which may contain credentials.
    console.error("Category seed failed. Check the local Aafiyat target, migration status, and category conflicts.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
