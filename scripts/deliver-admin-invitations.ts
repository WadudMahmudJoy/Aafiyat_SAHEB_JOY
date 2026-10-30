// Run with --conditions=react-server --import tsx. No public worker endpoint.
import "dotenv/config";
import { deliverNextInvitation } from "../src/lib/invitation-delivery";
import { prisma } from "../src/lib/prisma";

try {
  for (let i=0;i<20;i++) {
    const result=await deliverNextInvitation();
    console.log(`Invitation delivery: ${result.status}`);
    if (!["delivered","failed","expired","cancelled"].includes(result.status)) break;
  }
} finally { await prisma.$disconnect(); }
