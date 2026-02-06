# Issue Plan (ordered)

1. #37 Proxy: Harden run_shell Validation (Allowlist/Denylist + No-Network By Default)
2. #38 Proxy: Gate Network Tools (webfetch/web_search) Behind Explicit Flag
3. #36 Proxy: Tighten Path Safety (Block Absolute Paths, Reduce Sensitive False Positives)
4. #32 Proxy: Enforce Single-Step Tool Calling For Mutations (Confirmation Boundary)
5. #34 Proxy: Stop Inferring filePath For Mutation Tools (No Heuristic Mutations)
6. #35 Proxy: Bound Raw tool_calls Count (Apply Same Limits As Planner Actions)
7. #33 Proxy: Make too_many_actions Recoverable (Truncate Or Re-Ask Planner)

8. #20 Reduce extra chat-history round trips in proxy
9. #21 Reduce planner retry round trips
10. #22 Cache tool prompt and avoid repeated message conversion
11. #23 Optimize context token estimation loops
12. #24 Stream parser: reduce string churn and buffering
13. #25 Run shell tool: avoid buffering full stdout/stderr

14. #26 Split proxy handler for maintainability
15. #30 Split tool output parsing utilities
16. #27 Split GLMClient into focused modules
17. #28 Split tool-call inference helpers
18. #29 Split CLI into commands and login helpers
19. #31 Split web wrapper tools module
