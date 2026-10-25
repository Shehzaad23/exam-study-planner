# Exam Study Planner — CI/CD with Jenkins, Docker Hub and Minikube

**CCA 2 · Cloud Computing and DevOps**
Student: Shehzaad Kurawer · Roll no: 09 · PRN: 1262242419 · Panel/Batch: C/C1

| | |
|---|---|
| GitHub repository | `https://github.com/Shehzaad23/exam-study-planner` |
| Docker Hub image | `https://hub.docker.com/r/shehzaad23/exam-study-planner` |
| Jenkins (AWS EC2) | `http://13.206.94.88:8080` |
| Running app | `http://13.206.94.88:30080` |

---

## 1. The project

**Exam Study Planner** is a notebook-style web app for students. You enter your exam timetable and the units of each subject, and it builds a day-by-day study plan:

- earliest exam first, hard and high-marks units first, and a revision day before every exam
- a "Today" checklist; work you miss is pushed into the remaining days automatically
- on-track meter, exam countdown, progress per subject, study streak
- blocked days, notes per unit, a doubts list, calendar (.ics) export, print/PDF, backup/restore

**Tech:** Python + Flask backend (`app.py`, planning logic in `planner.py`), HTML/CSS/JavaScript frontend (`static/`), pytest unit tests (`tests/`). Data is stored in the browser, so no database is needed.

## 2. Repository layout

```
exam-study-planner/
├── app.py                 Flask web server (routes, /api/health, /api/version)
├── planner.py             Study-plan algorithm (pure Python, unit-tested)
├── static/                Frontend (index.html, style.css, app.js)
├── tests/                 42 pytest unit tests
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
| 1 | Checkout | Jenkins pulls the latest commit from GitHub and reads `VERSION` to make the image tag, e.g. `1.0.0-build3` |
| 2 | Build & Test | Creates a Python virtual environment, installs dependencies, compiles the code (`py_compile`) and runs the 42 pytest tests. Results are published in Jenkins (JUnit report). A failing test stops the pipeline. |
| 3 | Docker Build | Builds the image from the `Dockerfile`, tagged `<version>-build<number>` and `latest` |
| 4 | Push Image | Logs in to Docker Hub with credentials stored in Jenkins (`dockerhub-creds`) and pushes both tags |
| 5 | Deploy to Minikube | Writes the new image tag into the Deployment, runs `kubectl apply` for the Deployment and Service, and waits for the rolling update |
| 6 | Verify | Shows the deployment, pods and service, then calls `/api/health` and `/api/version` on the running app and fails if the wrong version is live |

The pipeline starts automatically on every `git push` through a GitHub webhook.

## 4. Setting up Jenkins on AWS

- **EC2 instance:** Ubuntu Server 24.04 LTS, m7i-flex.large (2 vCPU, 8 GB RAM, AWS Free Tier), 25 GB disk, plus a 2 GB swap file
- **Security group (inbound):** 22 (SSH), 8080 (Jenkins), 30080 (the app)
- **Installed:** Docker, OpenJDK 21, Jenkins (LTS), Python 3 venv, kubectl, Minikube, socat
- The `jenkins` user is in the `docker` group, and Minikube was started as the `jenkins` user, so the pipeline can run `docker` and `kubectl` directly
- **Plugins:** suggested plugins (Git, GitHub, Pipeline, Credentials Binding, JUnit, Timestamper) + Pipeline: Stage View
- **Credentials:** `dockerhub-creds` (Username with password: Docker Hub username + access token)
- **Job:** Pipeline, "Pipeline script from SCM" → this repository, branch `main`, script path `Jenkinsfile`, GitHub hook trigger enabled
- **Webhook:** GitHub → Settings → Webhooks → `http://EC2_PUBLIC_IP:8080/github-webhook/`

## 5. Pushing the image

Jenkins logs in to Docker Hub using the stored credential (the token never appears in the code or the logs) and pushes:

- `YOUR_DOCKERHUB_USERNAME/exam-study-planner:<version>-build<number>`, a unique tag for every build, so you can always tell which build is running
- `YOUR_DOCKERHUB_USERNAME/exam-study-planner:latest`

## 6. Deploying and accessing the app

- Minikube runs on the same EC2 instance (Docker driver)
- The Deployment runs **2 replicas** with readiness and liveness probes on `/api/health`, and `imagePullPolicy: Always`, so the pods pull the image from Docker Hub
- The Service is a **NodePort** on port **30080**
- A small `socat` forwarder on the EC2 instance passes `EC2_PUBLIC_IP:30080` to `minikube-ip:30080`, so the app opens from any browser at `http://EC2_PUBLIC_IP:30080`

Check it manually on the server:

```
sudo -u jenkins -H kubectl get deployment,pods,service -o wide
```

## 7. The second run (code change)

| | Run 1 | Run 2 |
|---|---|---|
| Version | 1.0.0 | 2.0.0 |
| Image tag | `1.0.0-build1` | `2.0.0-build2` |
| Change | — | Added a Pomodoro focus timer tab |

Steps: changed the code, set `VERSION` to `2.0.0`, then ran `git commit` and `git push`. The webhook started the pipeline automatically. Tests passed, the new image was pushed, Kubernetes did a rolling update to the new pods, and the Verify stage confirmed `/api/version` returned `2.0.0`. The app footer now shows **v2.0.0**.

## 8. Run it locally

```
docker compose up -d --build      # then open http://localhost:5000
pip install -r requirements-dev.txt && pytest   # run the tests
```
