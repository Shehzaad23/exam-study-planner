"""Exam Study Planner - Flask web server.

Routes:
  GET  /               the web app (static/index.html)
  GET  /api/health     health check, used by Docker and Kubernetes
  GET  /api/version    app version (handy to prove a new version got deployed)
  POST /api/plan       builds the day-by-day study plan
  POST /api/calendar   same plan as a downloadable .ics calendar file
"""
import os

from flask import Flask, Response, jsonify, request, send_from_directory

from planner import PlanError, build_ics, generate_plan


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", static_url_path="/static")
    version = os.environ.get("APP_VERSION", "1.0.0")

    def read_payload():
        payload = request.get_json(silent=True)
        if payload is None:
            raise PlanError("Send the planner data as JSON.")
        return payload

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/health")
    def health():
        return jsonify(status="ok")

    @app.get("/api/version")
    def get_version():
        return jsonify(version=version)

    @app.post("/api/plan")
    def plan():
        try:
            return jsonify(generate_plan(read_payload()))
        except PlanError as err:
            return jsonify(error=str(err)), 400

    @app.post("/api/calendar")
    def calendar():
        try:
            ics = build_ics(generate_plan(read_payload()))
        except PlanError as err:
            return jsonify(error=str(err)), 400
        return Response(
            ics,
            mimetype="text/calendar",
            headers={"Content-Disposition": 'attachment; filename="study-plan.ics"'},
        )

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))
