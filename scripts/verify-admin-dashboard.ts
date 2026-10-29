import 'dotenv/config';
import assert from 'node:assert/strict';
import { auth } from '../src/lib/auth';
import { prisma } from '../src/lib/prisma';
import { dashboardAreas, getAdminDashboard } from '../src/lib/admin-dashboard';
import { AdminAuthorizationError } from '../src/lib/admin-authorization';
import { prepareRehearsal, sameSnapshot } from '../src/lib/local-owner-rehearsal';

let passed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) { await run(); passed++; console.log(`PASS: ${name}`); }
async function verify() {
 const before = await prepareRehearsal();
 const original = { session: auth.api.getSession, admin: prisma.adminUser.findUnique, stored: prisma.session.findUnique, user: prisma.user.findUniqueOrThrow };
 const now = new Date();
 const session = { session: { id: 'dashboard-mock-session', userId: 'dashboard-mock-user', token: 'in-memory-binding', createdAt: now, expiresAt: new Date(Date.now()+60000) }, user: { id: 'dashboard-mock-user' } };
 let role = 'OWNER'; let active = true; let expired = false; let revoked = false; let proof = true; let authenticated = true; let identityReads = 0;
 try {
  Reflect.set(auth.api, 'getSession', async () => authenticated ? session : null);
  Reflect.set(prisma.adminUser, 'findUnique', async () => ({ id: 'mock-membership', userId: session.user.id, active, disabledAt: null, role: { name: role } }));
  Reflect.set(prisma.session, 'findUnique', async () => revoked ? null : ({ ...session.session, expiresAt: expired ? new Date(0) : session.session.expiresAt, mfaVerifiedAt: proof ? now : null, user: { twoFactorEnabled: true, twofactors: [{ verified: true }] } }));
  Reflect.set(prisma.user, 'findUniqueOrThrow', async (args: unknown) => { identityReads++; assert.deepEqual(args,{ where:{id:session.user.id},select:{name:true,email:true} }); return {name:'TEST Operator',email:'dashboard@example.invalid'}; });
  for (const [name, expected] of [['OWNER',['products','inventory','categories','orders','customers','marketing','content','settings','administration']],['PRODUCT_MANAGER',['products','inventory','categories']],['ORDER_MANAGER',['orders','customers']],['MARKETING_MANAGER',['products','categories','marketing','content']]] as const) {
   await test(`${name} receives only policy-permitted areas`,async()=> { role=name; const data=await getAdminDashboard(new Headers()); assert.deepEqual(data.areas.map(a=>a.id),expected); assert.deepEqual(Object.keys(data.identity).sort(),['email','name']); });
  }
  await test('marketing catalog read does not imply inventory or product-write controls',()=>assert.deepEqual(dashboardAreas('MARKETING_MANAGER')[0].features,['Product catalog']));
  await test('unknown role has no navigation grants',()=>assert.deepEqual(dashboardAreas('SUPER_ADMIN'),[]));
  role='OWNER';
  const denied = async () => { const count=identityReads; await assert.rejects(getAdminDashboard(new Headers()),e=>e instanceof AdminAuthorizationError); assert.equal(identityReads,count); };
  await test('unauthenticated direct dashboard access denied before identity lookup',async()=> { authenticated=false; await denied(); authenticated=true; });
  await test('password-only direct dashboard access denied',async()=> { proof=false; await denied(); proof=true; });
  await test('inactive membership denied',async()=> { active=false; await denied(); active=true; });
  await test('expired session denied',async()=> { expired=true; await denied(); expired=false; });
  await test('revoked session denied',async()=> { revoked=true; await denied(); revoked=false; });
  await test('each request revalidates authorization; no cached role grant',async()=> { role='OWNER'; await getAdminDashboard(new Headers()); active=false; await denied(); active=true; });
 } finally {
  Reflect.set(auth.api,'getSession',original.session); Reflect.set(prisma.adminUser,'findUnique',original.admin); Reflect.set(prisma.session,'findUnique',original.stored); Reflect.set(prisma.user,'findUniqueOrThrow',original.user);
 }
 await test('all twelve database fingerprints unchanged; no fixture writes',async()=>assert(sameSnapshot(before.baseline,(await prepareRehearsal()).baseline)));
 console.log(`${passed} dashboard policy/access checks passed; no identities provisioned.`);
}
verify().catch(()=>{console.error('Dashboard verification failed; sensitive details withheld.');process.exitCode=1;}).finally(async()=>{await prisma.$disconnect();});
