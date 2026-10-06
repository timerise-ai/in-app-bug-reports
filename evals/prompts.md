---
prompts:
  - prompt: "Add a 'report a bug' button to this app. People should be able to write what went wrong, attach screenshots, and see the team's replies and whether it was fixed. The team works in GitHub Issues."
    stack: Postgres
  - prompt: "Our in-app assistant should be able to help a user write up a bug report, but the user has to be the one who sends it."
    stack: Postgres
  - prompt: "Bug reports from the app reach GitHub, but closing the issue never updates the report in the app. Find out why."
---

# Prompts

What an operator types after installing this skill, in their own words. An agent eval installs the skill
into an empty Next.js app, gives the agent one of these prompts and no further help, then type-checks, builds
and tests the result; the first prompt runs before every release. The results are the other files in this
folder. Section 10 of [STANDARD.md](https://github.com/timerise-ai/skills/blob/main/STANDARD.md) says how a
run is made. The prompts and the newest runs are on
[the skill's page](https://timerise.ai/skills/in-app-bug-reports) on timerise.ai.
