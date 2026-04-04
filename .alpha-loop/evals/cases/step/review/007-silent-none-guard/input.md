# Batch review: Issues #187, #188, #189, #190

Review the combined changes from 4 issues implemented in a single batch.

## Issue #187: Autonomous simulation loop — continuous trigger-driven operation

Add a seedless, autonomous simulation mode where the orchestrator runs continuously using the existing trigger system to decide what happens next. No seed file required.

## Issue #188: Auto-scheduled reflections tied to simulation clock

ReflectionScheduler fires 6-hour, daily, and weekly reflections based on simulated clock intervals.

## Issue #189: Awakening seed scenario — Day 1 blank-slate simulation

9-phase Day 1 scenario covering first contact through evening wrap-up.

## Issue #190: Tool coverage seed scenario — exercise all 21 tools

25-phase scenario exercising all 19 tools with post-run validation script.

## Diff to review

```diff
diff --git a/core/simulation/orchestrator.py b/core/simulation/orchestrator.py
index 65a4658..8afb36b 100644
--- a/core/simulation/orchestrator.py
+++ b/core/simulation/orchestrator.py
@@ -167,30 +207,32 @@ class SimulationOrchestrator:
         self._start_time: float = 0.0
         self._total_cost = Decimal("0")
         self._cancelled = False
+        self.clock = SimulationClock(speed_multiplier=config.speed_multiplier)

     @property
     def simulation_id(self) -> uuid.UUID | None:
         return self._simulation_id

+    def _build_phase_runner(self, sim_id: uuid.UUID) -> PhaseRunner:
+        """Create a PhaseRunner with all dependencies wired."""
+        return PhaseRunner(
             config_loader=self._config_loader,
             agent_registry=self._agent_registry,
             llm_client=self._llm,
             memory_repo=self._memory_repo,
             conversation_repo=self._conv_repo,
             overseer=self._overseer,
-            simulation_id=sim.id,
+            simulation_id=sim_id,
             agents=self._config.agents,
             dry_run=self._config.dry_run,
             services=self._services,
+            clock=self.clock,
         )

+    async def run_autonomous(self) -> None:
+        """Run trigger-driven simulation until limits reached."""
+        self._start_time = time.monotonic()
+
+        sim = await self._sim_repo.create(SimulationCreate(
+            name=self._config.name,
+            description=self._config.description,
+            config=self._config.to_dict(),
+            status=SimulationStatus.running,
+            agents_participated=self._config.agents,
+        ))
+        self._simulation_id = sim.id
+        logger.info("Autonomous simulation %s started", sim.id)
+
+        runner = self._build_phase_runner(sim.id)
+        scheduler = self._build_reflection_scheduler()
+
+        # Trigger system drives all conversation starts
+        from core.conversation.triggers import TriggerSystem
+        trigger_config = self._config_loader.config.triggers
+        trigger_system = TriggerSystem(
+            config=trigger_config,
+            event_bus=self._services.event_bus,
+        )
+
+        day_convs = 0
+        current_day = 1
+
+        while not self._should_stop():
+            # Check for day boundary
+            sim_day = self.clock.simulated_day()
+            if sim_day > current_day:
+                logger.info(
+                    "=== Day %d complete: %d conversations ===",
+                    current_day, day_convs,
+                )
+                day_convs = 0
+                current_day = sim_day
+
+            # Wait for next trigger
+            event = await trigger_system.wait_for_next()
+
+            if event.type == "idle":
+                # Run an organic conversation
+                phase_start = time.monotonic()
+                await runner.run_phase(Phase(
+                    name=f"organic-{day_convs + 1}",
+                    phase_type=PhaseType.organic_chat,
+                    agents=self._config.agents,
+                ))
+                elapsed = time.monotonic() - phase_start
+                self.clock.advance(timedelta(seconds=elapsed))
+                day_convs += 1
+
+            elif event.type == "scheduled":
+                phase_start = time.monotonic()
+                await runner.run_phase(Phase(
+                    name=f"scheduled-{event.schedule.name}",
+                    phase_type=PhaseType.from_trigger(event),
+                    agents=event.schedule.agents or self._config.agents,
+                ))
+                elapsed = time.monotonic() - phase_start
+                self.clock.advance(timedelta(seconds=elapsed))
+
+            # Check reflections after each conversation
+            await scheduler.check_and_run_all(self._config.agents)
+
+            # Idle gap between conversations
+            gap = random.uniform(2.0, 8.0)
+            await asyncio.sleep(gap if self._config.speed != "fast" else 0.1)
+            self.clock.advance(timedelta(minutes=random.uniform(10, 45)))
+
+        # Finalize
+        await self._finalize_simulation(sim.id)

diff --git a/core/conversation/triggers.py b/core/conversation/triggers.py
--- a/core/conversation/triggers.py
+++ b/core/conversation/triggers.py
@@ -15,8 +15,8 @@
 class TriggerSystem:
-    def __init__(self, config, event_bus):
+    def __init__(self, config, event_bus, clock=None, now_fn=None):
         self._config = config
         self._event_bus = event_bus
+        self._clock = clock
+        self._now_fn = now_fn or (lambda: datetime.now(timezone.utc))
         self._idle_start = time.monotonic()

     async def wait_for_next(self) -> TriggerEvent:
         """Wait for and return the next trigger event."""
-        now = datetime.now(timezone.utc)
+        now = self._now_fn()
         for schedule in self._config.schedules:
             if self._should_fire(schedule, now):
                 return TriggerEvent(type="scheduled", schedule=schedule)
         idle_seconds = time.monotonic() - self._idle_start
         if idle_seconds >= self._config.idle_timeout:
             self._idle_start = time.monotonic()
             return TriggerEvent(type="idle")
         await asyncio.sleep(1)

diff --git a/core/simulation/phases.py b/core/simulation/phases.py
--- a/core/simulation/phases.py
+++ b/core/simulation/phases.py
@@ -95,6 +96,7 @@ class PhaseRunner:
         agents: list[str],
         dry_run: bool = False,
         services: Services | None = None,
+        clock: SimulationClock | None = None,
     ) -> None:
         self._config_loader = config_loader
         self._agents = agent_registry
@@ -114,6 +116,7 @@ class PhaseRunner:
         self._agent_ids = agents
         self._dry_run = dry_run
         self._services = services
+        self._clock = clock

diff --git a/core/memory/reflection_scheduler.py b/core/memory/reflection_scheduler.py
new file mode 100644
--- /dev/null
+++ b/core/memory/reflection_scheduler.py
@@ -0,0 +1,137 @@
+"""ReflectionScheduler — auto-scheduled reflections tied to simulation clock."""
+
+class ReflectionScheduler:
+    def __init__(
+        self,
+        clock: SimulationClock,
+        reflection_manager: ReflectionManager,
+        *,
+        six_hour_interval_hours: int = 6,
+        daily_hour: int = 23,
+        weekly_day: int = 7,
+    ) -> None:
+        self._clock = clock
+        self._reflection = reflection_manager
+        self._six_hour_interval = timedelta(hours=six_hour_interval_hours)
+        self._daily_hour = daily_hour
+        self._weekly_day = weekly_day
+        self._init_time = clock.now()
+        self._last_6hour: dict[str, datetime] = {}
+        self._last_daily: dict[str, str] = {}
+        self._last_weekly: dict[str, int] = {}
+
+    async def check_and_run(self, agent_id: str) -> list[ReflectionResult]:
+        self._ensure_tracking(agent_id)
+        now = self._clock.now()
+        results = []
+
+        # Weekly reflection
+        current_day = self._clock.simulated_day()
+        if current_day >= self._weekly_day and current_day % self._weekly_day == 0:
+            if self._last_weekly.get(agent_id) != current_day:
+                result = await self._reflection.run_weekly_reflection(agent_id)
+                results.append(result)
+                self._last_weekly[agent_id] = current_day
+                self._last_6hour[agent_id] = now
+                self._last_daily[agent_id] = now.strftime("%Y-%m-%d")
+                return results
+
+        # Daily reflection (at configured hour)
+        today_str = now.strftime("%Y-%m-%d")
+        if now.hour >= self._daily_hour and self._last_daily.get(agent_id) != today_str:
+            result = await self._reflection.run_6hour_reflection(agent_id)
+            results.append(result)
+            self._last_daily[agent_id] = today_str
+            self._last_6hour[agent_id] = now
+            return results
+
+        # 6-hour reflection (80% threshold)
+        elapsed = now - self._last_6hour[agent_id]
+        if elapsed >= self._six_hour_interval * 0.8:
+            result = await self._reflection.run_6hour_reflection(agent_id)
+            results.append(result)
+            self._last_6hour[agent_id] = now
+
+        return results

diff --git a/scripts/run_simulation.py b/scripts/run_simulation.py
--- a/scripts/run_simulation.py
+++ b/scripts/run_simulation.py
@@ -54,11 +51,19 @@ async def run_simulation(args: argparse.Namespace) -> None:
     agents = [a.strip() for a in args.agents.split(",")]
+    duration = None
+    if args.duration:
+        duration = parse_duration(args.duration)
+
     sim_config = SimulationConfig(
         name=args.name,
         description=args.description,
-        seed_file=args.seed_file,
+        seed_file=args.seed_file,  # now optional
         agents=agents,
         max_cost=args.max_cost,
         speed=args.speed,
+        speed_multiplier=args.speed_multiplier,
+        duration=duration,
         dry_run=args.dry_run,
     )
@@ -142,7 +149,10 @@ async def run_simulation(args: argparse.Namespace) -> None:
-    await orchestrator.run()
+    if sim_config.mode == "autonomous":
+        await orchestrator.run_autonomous()
+    else:
+        await orchestrator.run()
```
