import json
from pathlib import Path

import flask
import pytest
from click.testing import CliRunner
from flask import Flask
from flask.cli import FlaskGroup


def test_config_command_masks_without_mutation():
    app = Flask(__name__)
    keys = ['APP_SECRET', 'db_password', 'Api_Token', 'publicKey', 'KEYSTONE']
    values = {key: f'sample-value-{index}' for index, key in enumerate(keys)}
    app.config.update(values)
    app.config['PUBLIC_SETTING'] = 'visible'
    before = dict(app.config)
    cli = FlaskGroup(create_app=lambda: app, load_dotenv=False)
    result = CliRunner().invoke(cli, ['config'])
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    assert data['PUBLIC_SETTING'] == 'visible'
    for key, value in values.items():
        assert data[key] == '***'
        assert value not in result.output
    assert dict(app.config) == before
    assert 'PERMANENT_SESSION_LIFETIME' in data


def test_config_help_and_checkout():
    cli = FlaskGroup(create_app=lambda: Flask(__name__), load_dotenv=False)
    result = CliRunner().invoke(cli, ['--help'])
    assert result.exit_code == 0, result.output
    assert any(line.strip().startswith('config ') for line in result.output.splitlines())
    assert Path(flask.__file__).resolve().is_relative_to(Path(__file__).resolve().parents[1] / 'src')
