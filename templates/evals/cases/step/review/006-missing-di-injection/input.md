## Issue: Add ArtifactRepository to store build artifacts

### Diff

```diff
+++ b/src/services/artifact-repo.ts
@@ -0,0 +1,25 @@
+export class ArtifactRepository {
+  constructor(private db: Database) {}
+
+  async save(artifact: Artifact): Promise<void> {
+    await this.db.insert('artifacts', artifact);
+  }
+
+  async findById(id: string): Promise<Artifact | null> {
+    return this.db.query('artifacts', { id });
+  }
+}

+++ b/src/services/build-service.ts
@@ -5,8 +5,12 @@
 export class BuildService {
-  constructor(private runner: BuildRunner) {}
+  constructor(
+    private runner: BuildRunner,
+    private artifactRepo?: ArtifactRepository,
+  ) {}

   async runBuild(config: BuildConfig): Promise<BuildResult> {
     const result = await this.runner.execute(config);
+    if (this.artifactRepo) {
+      await this.artifactRepo.save(result.artifact);
+    }
     return result;
   }

+++ b/src/bootstrap.ts
@@ -10,6 +10,8 @@
 export function bootstrap(db: Database): AppContainer {
   const runner = new BuildRunner();
-  const buildService = new BuildService(runner);
+  const artifactRepo = new ArtifactRepository(db);
+  const buildService = new BuildService(runner);
   return { buildService };
 }
```

### Analysis Required

Review this diff for wiring correctness. The issue asked for ArtifactRepository to store build artifacts.
