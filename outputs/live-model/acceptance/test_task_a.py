from pathlib import Path
import flask
import pytest
from flask.helpers import get_debug_flag

@pytest.mark.parametrize('value', [None, '', '0', 'false', 'FALSE', 'False', 'no', 'NO', 'off', 'OFF', 'OfF', 'n', 'N'])
def test_false_values(monkeypatch, value):
    if value is None:
        monkeypatch.delenv('FLASK_DEBUG', raising=False)
    else:
        monkeypatch.setenv('FLASK_DEBUG', value)
    assert get_debug_flag() is False

@pytest.mark.parametrize('value', ['1', 'true', 'yes', 'on', 'y', 'other'])
def test_truthy_values(monkeypatch, value):
    monkeypatch.setenv('FLASK_DEBUG', value)
    assert get_debug_flag() is True

def test_docstring_and_actual_checkout():
    for value in ['0', 'false', 'no', 'off', 'n']:
        assert f"'{value}'" in get_debug_flag.__doc__
    assert Path(flask.__file__).resolve().is_relative_to(Path(__file__).resolve().parents[1] / 'src')
