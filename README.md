# Exam Study Planner — CI/CD with Jenkins, Docker Hub and Minikube

**CCA 2 · Cloud Computing and DevOps**
Student: **Shehzaad Kurawer** · Roll no: **09** · Panel C, Batch C1

| | |
|---|---|
| GitHub repository | https://github.com/Shehzaad23/exam-study-planner |
| Docker Hub image | https://hub.docker.com/r/shehzaad23/exam-study-planner |
| Jenkins (AWS EC2) | `http://13.206.94.88:8080` |
| Running app | `http://13.206.94.88:30080` |

> The EC2 public IP changes whenever the instance is stopped and started, so the two addresses above are the ones used during the demo.

---

## 1. The project

**Exam Study Planner** is a notebook-style web app for students. You enter your exam timetable and the units of each subject, and it builds a day-by-day study plan:

- earliest exam first, hard and high-marks units first, and a revision day before every exam
- a "Today" checklist; work you miss is pushed into the remaining days automatically
- on-track meter, exam countdown, progress per subject, study streak
- blocked days, notes per unit, a doubts list, calendar (.ics) export, print/PDF, backup/restore
- **v2.0.0:** a Pomodoro **Focus** timer (25-minute sessions, short and long breaks, sessions per subject)

**Tech:** Python + Flask backend (`app.py`, planning logic in `planner.py`), HTML/CSS/JavaScript frontend (`static/`), pytest unit tests (`tests/`). Data is stored in the browser, so no database is needed.

## 2. Repository layout

```
exam-study-planner/
├── app.py                 Flask web server (routes, /api/health, /api/version)
├── planner.py             Study-plan algorithm (pure Python, unit-tested)
├── static/                Frontend (index.html, style.css, app.js)
├── tests/                 43 pytest unit tests
├── requirements.txt       Runtime dependencies (Flask, Gunicorn)
├── requirements-dev.txt   + pytest, used by the pipeline's test stage
├── VERSION                App version; becomes part of the Docker image tag
├── Dockerfile             Builds the container image
├── docker-compose.yml     Runs the app on a laptop (local testing only)
├── Jenkinsfile            Declarative CI/CD pipeline
└── k8s/
    ├── deployment.yaml    Kubernetes Deployment (2 replicas, health probes)
    └── service.yaml       Kubernetes NodePort Service (port 30080)
```

## 3. Pipeline stages

```
GitHub ──push──▶ Jenkins (AWS EC2)
                   1 Checkout ─▶ 2 Build & Test ─▶ 3 Docker Build ─▶ 4 Push Image ─▶ 5 Deploy to Minikube ─▶ 6 Verify
                                                                        │                     ▲
                                                                        ▼                     │ pulls image
                                                                   Docker Hub ────────────────┘
```

| # | Stage | What it does |
|---|---|---|
| 1 | Checkout | Jenkins pulls the latest commit from GitHub and reads `VERSION` to make the image tag, e.g. `2.0.0-build3` |
| 2 | Build & Test | Creates a Python virtual environment, installs dependencies, compiles the code (`py_compile`) and runs the pytest suite. Results are published in Jenkins as a JUnit report. A failing test stops the pipeline. |
| 3 | Docker Build | Builds the image from the `Dockerfile`, tagged `<version>-build<number>` and `latest` |
| 4 | Push Image | Logs in to Docker Hub with the credential stored in Jenkins (`dockerhub-creds`) and pushes both tags |
| 5 | Deploy to Minikube | Writes the new image tag into the Deployment, runs `kubectl apply` for the Deployment and Service, and waits for the rolling update |
| 6 | Verify | Shows the deployment, pods and service, then calls `/api/version` on the running app (retrying for up to a minute) and fails if the expected version is not live |

The pipeline starts automatically on every `git push` through a GitHub webhook.

## 4. Setting up Jenkins on AWS

- **EC2 instance:** Ubuntu Server, m7i-flex.large (2 vCPU, 8 GB RAM, AWS Free Tier), region ap-south-1 (Mumbai), 30 GB disk, plus a 2 GB swap file
- **Security group (inbound):** 22 (SSH), 8080 (Jenkins), 30080 (the app)
- **Installed:** Docker, OpenJDK 21, Jenkins (LTS 2.580), Python 3 venv, kubectl 1.37, Minikube 1.39, socat
- The `jenkins` user is in the `docker` group, and Minikube was started as the `jenkins` user, so the pipeline can run `docker` and `kubectl` directly
- **Plugins:** suggested plugins (Pipeline, Git, GitHub, GitHub Branch Source, Credentials Binding, JUnit, Timestamper) + Pipeline: Stage View
- **Credentials:** `dockerhub-creds` (Username with password: Docker Hub username + access token)
- **Job:** `exam-study-planner-pipeline`, "Pipeline script from SCM" → this repository, branch `main`, script path `Jenkinsfile`, GitHub hook trigger enabled
- **Webhook:** GitHub → Settings → Webhooks → `http://13.206.94.88:8080/github-webhook/` (push events)

## 5. Pushing the image

Jenkins logs in to Docker Hub using the stored credential (the token never appears in the code, and Jenkins masks it in the logs) and pushes:

- `shehzaad23/exam-study-planner:<version>-build<number>`, a unique tag for every build, so it is always clear which build is running (e.g. `1.0.0-build1`, `2.0.0-build3`)
- `shehzaad23/exam-study-planner:latest`

## 6. Deploying and accessing the app

- Minikube runs on the same EC2 instance (Docker driver)
- The Deployment runs **2 replicas** with readiness and liveness probes on `/api/health`, a rolling update with `maxUnavailable: 0` (no downtime), and `imagePullPolicy: Always`, so the pods pull the image from Docker Hub
- The Service is a **NodePort** on port **30080**
- A small `socat` forwarder on the EC2 instance (systemd service `planner-forward`) passes `EC2_IP:30080` to `minikube-ip:30080`, so the app opens from any browser at `http://13.206.94.88:30080`

Check it on the server:

```
sudo -u jenkins -H kubectl get deployment,pods,service -o wide
sudo -u jenkins -H kubectl describe pod -l app=exam-study-planner | grep -E "Image:|Image ID:"
sudo -u jenkins -H kubectl get events --sort-by=.lastTimestamp | grep -i pull
```

The `Image ID` (`docker.io/shehzaad23/exam-study-planner@sha256:…`) and the "Successfully pulled image" events confirm the pods pull the image from Docker Hub.

## 7. The second run (code change)

| | Run 1 | Run 2 |
|---|---|---|
| Version | 1.0.0 | 2.0.0 |
| Image tag | `1.0.0-build1` | `2.0.0-build3` |
| Change | — | Added a Pomodoro **Focus** timer tab, plus one new test (42 → 43 tests) |

**Steps:** added the feature, set `VERSION` to `2.0.0`, then ran `git commit` and `git push`. The webhook started the pipeline automatically.

- **Build #2** passed checkout, tests, Docker build, push and deploy, but **failed at Verify**. The new pods were healthy and already serving 2.0.0; the single check ran a moment after the rolling update, before the Service had switched to the new pods.
- **Fix:** the Verify stage now retries up to 12 times, 5 seconds apart, with a 5-second timeout per call. Pushing this fix triggered **build #3**, which passed every stage and confirmed version 2.0.0 on the first attempt.
- The app footer now shows **v2.0.0**, the Focus tab is live, and `kubectl rollout history` shows the new revisions.

## 8. Challenges and fixes

| Problem | Fix |
|---|---|
| t3.micro (1 GB RAM) is too small for Jenkins + Minikube | Used the free-tier m7i-flex.large (8 GB) + 2 GB swap |
| Minikube could not start: the default 8 GB disk was full | Resized the EBS volume to 30 GB and grew the partition (`growpart`, `resize2fs`) |
| Minikube's network is private to the server | Added a `socat` forwarder from EC2 port 30080 to Minikube |
| Verify failed right after a rolling update | Made the check retry for up to a minute |

## 9. Run it locally

```
docker compose up -d --build      # then open http://localhost:5000
pip install -r requirements-dev.txt && pytest   # run the tests
```
