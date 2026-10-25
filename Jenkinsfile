// Exam Study Planner - CI/CD pipeline
//
// GitHub -> Jenkins -> tests -> Docker image -> Docker Hub -> Minikube
//
// Before the first run, change DOCKER_IMAGE below to YOUR Docker Hub username.
// Jenkins needs one credential: "dockerhub-creds" (Docker Hub username + access token).

pipeline {
    agent any

    environment {
        DOCKER_IMAGE = 'shehzaad23/exam-study-planner'   // <-- change this
        K8S_APP      = 'exam-study-planner'
        NODE_PORT    = '30080'
    }

    triggers {
        // Start automatically when you push to GitHub (needs the GitHub webhook).
        githubPush()
    }

    options {
        timestamps()
        buildDiscarder(logRotator(numToKeepStr: '10'))
        timeout(time: 30, unit: 'MINUTES')
    }

    stages {

        stage('Checkout') {
            steps {
                // Pull the latest code from the GitHub repository this job is connected to
                checkout scm
                script {
                    env.APP_VERSION = readFile('VERSION').trim()
                    env.IMAGE_TAG   = "${env.APP_VERSION}-build${env.BUILD_NUMBER}"
                }
                echo "Building version ${env.APP_VERSION} as image tag ${env.IMAGE_TAG}"
                sh 'git log -1 --oneline'
            }
        }

        stage('Build & Test') {
            steps {
                sh '''
                    python3 -m venv .venv
                    . .venv/bin/activate
                    pip install --quiet --upgrade pip
                    pip install --quiet -r requirements-dev.txt

                    # "Build" step for Python: compile every file to catch syntax errors
                    python -m py_compile app.py planner.py

                    # Run the unit tests and save a report for Jenkins
                    pytest --junitxml=test-results.xml
                '''
            }
            post {
                always {
                    junit 'test-results.xml'
                }
            }
        }

        stage('Docker Build') {
            steps {
                sh '''
                    docker build \
                      --build-arg APP_VERSION=${APP_VERSION} \
                      -t ${DOCKER_IMAGE}:${IMAGE_TAG} \
                      -t ${DOCKER_IMAGE}:latest \
                      .
                    docker images ${DOCKER_IMAGE}
                '''
            }
        }

        stage('Push Image') {
            steps {
                // The Docker Hub token is stored securely in Jenkins, never in the code
                withCredentials([usernamePassword(credentialsId: 'dockerhub-creds',
                                                  usernameVariable: 'DH_USER',
                                                  passwordVariable: 'DH_TOKEN')]) {
                    sh '''
                        echo "$DH_TOKEN" | docker login -u "$DH_USER" --password-stdin
                        docker push ${DOCKER_IMAGE}:${IMAGE_TAG}
                        docker push ${DOCKER_IMAGE}:latest
                    '''
                }
            }
        }

        stage('Deploy to Minikube') {
            steps {
                sh '''
                    # Put this build's image tag into the Deployment, then apply both files
                    sed -E "s|image: .*|image: ${DOCKER_IMAGE}:${IMAGE_TAG}|" k8s/deployment.yaml > deployment.generated.yaml
                    kubectl apply -f deployment.generated.yaml
                    kubectl apply -f k8s/service.yaml

                    # Wait until the new pods are running
                    kubectl rollout status deployment/${K8S_APP} --timeout=180s
                '''
            }
        }

        stage('Verify') {
            steps {
                sh '''
                    echo "----- Deployment -----"
                    kubectl get deployment ${K8S_APP} -o wide
                    echo "----- Pods -----"
                    kubectl get pods -l app=${K8S_APP} -o wide
                    echo "----- Service -----"
                    kubectl get service ${K8S_APP}

                    # Call the running app and check it reports the version we just built
                    URL="http://$(minikube ip):${NODE_PORT}"
                    curl -fsS "$URL/api/health"; echo
                    DEPLOYED=$(curl -fsS "$URL/api/version")
                    echo "App says: $DEPLOYED"
                    echo "$DEPLOYED" | grep -q "\\"${APP_VERSION}\\"" || { echo "Wrong version is running!"; exit 1; }
                '''
            }
        }
    }

    post {
        success {
            echo "Version ${env.APP_VERSION} (image ${env.DOCKER_IMAGE}:${env.IMAGE_TAG}) is live on Minikube."
        }
        always {
            sh 'docker logout || true'
            sh 'docker image prune -f || true'
        }
    }
}
