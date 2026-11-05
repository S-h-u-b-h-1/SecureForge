"""Model-independent reference-patch rehearsal for the pinned competition checkout.

This validates reference behavior and retrieval inputs. It does not claim that an
AI model discovered or authored these edits, or that a competition video exists.
"""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid

PIN = "22d924701a6ae2e4cd01e9a15bbaf3946094af65"
TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false."
TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.'

def run(command, root, environment=None):
    result = subprocess.run(command, cwd=root, env=environment, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError("Command failed: " + " ".join(command) + "\n" + result.stdout + result.stderr)
    return result.stdout

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkout", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(args.checkout).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / "FLASK-LICENSE.txt").write_text((root / "LICENSE.txt").read_text())
    if run(["git", "rev-parse", "HEAD"], root).strip() != PIN:
        raise RuntimeError("Checkout does not match the official Flask revision")
    if run(["git", "status", "--porcelain"], root).strip():
        raise RuntimeError("Use a clean disposable Flask checkout")
    originals = {}
    for name in ["src/flask/helpers.py", "src/flask/cli.py", "tests/test_cli.py", "docs/cli.rst"]:
        originals[name] = (root / name).read_text()
    modified = dict(originals)
    modified["src/flask/helpers.py"] = originals["src/flask/helpers.py"].replace(
        ':envvar:`FLASK_DEBUG` environment variable. The default is ``False``.',
        ':envvar:`FLASK_DEBUG` environment variable. Unset, empty, ``0``,\n    ``false``, ``no``, ``off`` and ``n`` are false, case-insensitively.'
    ).replace('{"0", "false", "no"}', '{"0", "false", "no", "off", "n"}')
    modified["src/flask/cli.py"] = originals["src/flask/cli.py"].replace("import inspect\n", "import inspect\nimport json\n").replace(
        "            self.add_command(routes_command)\n", "            self.add_command(routes_command)\n            self.add_command(config_command)\n"
    )
    command = '''
@click.command("config", short_help="Show application configuration as masked JSON.")
@with_appcontext
def config_command() -> None:
    """Print the loaded application's configuration with sensitive keys masked."""
    def mask(value):
        if isinstance(value, dict):
            return {
                key: "***" if any(word in str(key).upper() for word in ("SECRET", "PASSWORD", "TOKEN", "KEY")) else mask(item)
                for key, item in value.items()
            }
        if isinstance(value, (list, tuple)):
            return [mask(item) for item in value]
        return value

    click.echo(json.dumps(mask(dict(current_app.config)), default=str, sort_keys=True))


'''
    modified["src/flask/cli.py"] = modified["src/flask/cli.py"].replace("cli = FlaskGroup(\n", command + "cli = FlaskGroup(\n")
    modified["tests/test_cli.py"] += '''

def test_config_command_masks_sensitive_values():
    import json
    app = Flask(__name__)
    app.config.update(SECRET_KEY="example", PASSWORD="example", API_TOKEN="example", PUBLIC="visible", NESTED={"api_key": "example"})
    cli = FlaskGroup(create_app=lambda: app)
    result = CliRunner().invoke(cli, ["config"])
    assert result.exit_code == 0
    values = json.loads(result.output)
    assert values["SECRET_KEY"] == "***"
    assert values["PASSWORD"] == "***"
    assert values["API_TOKEN"] == "***"
    assert values["PUBLIC"] == "visible"
    assert values["NESTED"]["api_key"] == "***"
    assert "config" in CliRunner().invoke(cli, ["--help"]).output
'''
    modified["docs/cli.rst"] += '''

View Configuration
------------------

The built-in ``flask config`` command prints the loaded application's configuration
as JSON. Keys containing SECRET, PASSWORD, TOKEN or KEY are masked as ``***``.
Masking applies to nested dictionaries too. Configure the app with ``--app`` as
with the other built-in commands. Review configuration output before sharing it.
'''
    proposals = []
    patch = []
    for name, content in modified.items():
        original = originals[name]
        proposals.append({"schemaVersion": 1, "id": str(uuid.uuid4()), "status": "pending", "path": name,
                          "baseSha256": digest(original), "proposedSha256": digest(content),
                          "originalContent": original, "proposedContent": content,
                          "rationale": "Manually specified reference rehearsal; not AI-generated"})
        patch.extend(difflib.unified_diff(original.splitlines(True), content.splitlines(True), fromfile="a/" + name, tofile="b/" + name))
        (root / name).write_text(content)
    (output / "reference-proposals.json").write_text(json.dumps({"id": "flask-reference-rehearsal", "proposals": proposals}, indent=2))
    (output / "reference-flask.patch").write_text("".join(patch))
    environment = {**os.environ, "FLASK_DEBUG": "off", "PYTHONPATH": str(root / "src")}
    task_a = run([args.python, "-c", "from flask.helpers import get_debug_flag; print(get_debug_flag())"], root, environment).strip()
    if task_a != "False":
        raise RuntimeError("Task A reference verification failed")
    for value in ["off", "OFF", "n", "N", "0", "false", "no", ""]:
        environment["FLASK_DEBUG"] = value
        assert run([args.python, "-c", "from flask.helpers import get_debug_flag; print(get_debug_flag())"], root, environment).strip() == "False"
    environment.pop("FLASK_DEBUG", None)
    tests = run([args.python, "-m", "pytest", "tests/test_cli.py", "-q"], root, environment)
    demo = output / "rehearsal_app.py"
    demo.write_text('from flask import Flask\napp = Flask(__name__)\napp.config.update(SECRET_KEY="example", API_TOKEN="example", PUBLIC="visible")\n')
    command_output = run([args.python, "-m", "flask", "--app", str(demo), "config"], root, environment)
    values = json.loads(command_output)
    assert values["SECRET_KEY"] == "***" and values["API_TOKEN"] == "***" and values["PUBLIC"] == "visible"
    help_output = run([args.python, "-m", "flask", "--help"], root, environment)
    assert "config" in help_output
    report = {"mode": "model-independent reference rehearsal", "flaskCommit": PIN,
              "taskA": {"instruction": TASK_A, "result": task_a}, "taskB": {"instruction": TASK_B, "changedFiles": list(modified)[1:],
              "pytest": tests, "maskedJson": values, "helpContainsConfig": True},
              "taskC": {"status": "separate failure-path tests; production-model run skipped"},
              "limitations": ["Reference edits were specified by the developer, not autonomously discovered by a model.",
                               "This report is not a competition demo or proof of model success."]}
    (output / "flask-rehearsal.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"taskA": task_a, "taskB": tests.strip().splitlines()[-1], "files": len(modified) - 1, "report": str(output / "flask-rehearsal.json")}))

if __name__ == "__main__":
    main()
