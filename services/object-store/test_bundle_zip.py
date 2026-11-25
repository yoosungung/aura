import asyncio
from pathlib import Path

from bundle_zip import is_zip, load_factory_from_bytes


def test_plain_and_zip_factory(tmp_path: Path):
    plain = b"def factory(cfg, secrets_ref):\n    return {'runTurn': lambda ctx: {'ok': True}}\n"
    fac = load_factory_from_bytes(plain, "main:factory")
    assert callable(fac)

    import zipfile
    import io

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            "main.py",
            "from lib.helper import FLAG\n"
            "def factory(cfg, secrets_ref):\n"
            "    async def runTurn(ctx=None):\n"
            "        return {'text': FLAG}\n"
            "    return {'runTurn': runTurn}\n",
        )
        zf.writestr("lib/helper.py", "FLAG = 'zip-ok'\n")
        zf.writestr("lib/__init__.py", "")
    body = buf.getvalue()
    assert is_zip(body)
    fac2 = load_factory_from_bytes(body, "main:factory")
    inst = fac2({}, None)
    out = asyncio.run(inst["runTurn"]())
    assert out["text"] == "zip-ok"
