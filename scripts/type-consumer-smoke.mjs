// Typechecks the built public declarations as a consumer that has only the documented peer and
// schema dependency available. Keeping the private RPC engine out of this fixture makes a leaked
// oRPC declaration fail even when the repository's own devDependencies would hide it.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(join(tmpdir(), 'service-plane-type-consumer-'));

try {
  const fixtureModules = join(fixture, 'node_modules');
  const fixturePackage = join(fixtureModules, 'service-plane');
  await mkdir(fixturePackage, { recursive: true });
  await cp(join(root, 'dist'), join(fixturePackage, 'dist'), { recursive: true });
  await writeFile(join(fixturePackage, 'package.json'), await readFile(join(root, 'package.json')));

  await symlink(join(root, 'node_modules', 'hono'), join(fixtureModules, 'hono'), 'junction');
  await mkdir(join(fixtureModules, '@standard-schema'), { recursive: true });
  await symlink(join(root, 'node_modules', '@standard-schema', 'spec'), join(fixtureModules, '@standard-schema', 'spec'), 'junction');

  await writeFile(
    join(fixture, 'consumer.ts'),
    `import { ServicePlaneControlPlane as RootControlPlane } from 'service-plane';
import { type BrokerCaller, ServicePlaneControlPlane } from 'service-plane/control-plane';
import { createAbilityBuilder } from 'service-plane/service';

type ConsumerEnv = { Bindings: { SIGNING_SECRET: string } };
const caller = { id: 'consumer', kind: 'user' } satisfies BrokerCaller;
const plane = new ServicePlaneControlPlane<ConsumerEnv>({
  broker: false,
  invocationMiddleware: async (context, next) => {
    context.set('servicePlaneCaller', caller);
    await next();
  },
  services: () => [],
  signingKeys: (bindings) => [{ kid: 'consumer', secret: bindings.SIGNING_SECRET }],
});
void RootControlPlane;
void createAbilityBuilder;
void plane;
`,
  );
  await writeFile(
    join(fixture, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2022',
        },
        files: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );

  execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', 'tsconfig.json'], {
    cwd: fixture,
    stdio: 'inherit',
  });
  console.log('public declaration smoke ok: root, service, and control-plane entrypoints');
} finally {
  await rm(fixture, { force: true, recursive: true });
}
