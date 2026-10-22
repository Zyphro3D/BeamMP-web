"""Analyse des zip de mods : type, nom, image d'aperçu, métadonnées.

Mêmes sorties que lib/modAnalyzer.ts + lib/zipPreview.ts de la v2, avec
trois corrections tirées de la lecture du Lua de BeamNG :
- le jeu lit du SJSON (virgules facultatives, commentaires, clés sans
  guillemets) : parse_sjson() l'accepte, là où l'ancien « JSON tolérant »
  échouait sur des fichiers officiels ;
- les configurations viennent des fichiers .pc, info_<config>.json est
  facultatif : un mod qui ne livre que des .pc n'est plus sous-compté ;
- l'aperçu accepte default.png comme le jeu, pas seulement default.jpg.
"""

from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

# Taille décompressée au-delà de laquelle un aperçu est refusé sans être
# lu : une petite entrée très compressible pourrait sinon gonfler à
# plusieurs Go en mémoire (bombe zip).
MAX_PREVIEW_UNCOMPRESSED = 20 * 1024 * 1024
# Les info*.json font quelques Ko ; marge large, pas une limite de travail.
MAX_JSON_ENTRY = 1 * 1024 * 1024
MAX_CONFIGS_SCANNED = 80
MAX_CONFIGS_LISTED = 12

Image.MAX_IMAGE_PIXELS = 64_000_000  # refuse les images aberrantes (bombe de décompression)


# ── SJSON (format des fichiers BeamNG) ─────────────────────────

class SJSONError(ValueError):
    pass


class _Parser:
    def __init__(self, text: str):
        self.s = text
        self.i = 0
        self.n = len(text)

    def ws(self) -> None:
        s, n = self.s, self.n
        while self.i < n:
            c = s[self.i]
            if c in " \t\r\n﻿":
                self.i += 1
            elif s.startswith("//", self.i):
                j = s.find("\n", self.i)
                self.i = n if j < 0 else j + 1
            elif s.startswith("/*", self.i):
                j = s.find("*/", self.i + 2)
                self.i = n if j < 0 else j + 2
            else:
                break

    def value(self) -> Any:
        self.ws()
        if self.i >= self.n:
            raise SJSONError("fin inattendue")
        c = self.s[self.i]
        if c == "{":
            return self.obj()
        if c == "[":
            return self.arr()
        if c == '"':
            return self.string()
        return self.bare()

    def obj(self) -> dict[str, Any]:
        self.i += 1
        out: dict[str, Any] = {}
        while True:
            self.ws()
            if self.i >= self.n:
                raise SJSONError("objet non fermé")
            if self.s[self.i] == "}":
                self.i += 1
                return out
            if self.s[self.i] == ",":
                self.i += 1
                continue
            key = self.string() if self.s[self.i] == '"' else self.bare_key()
            self.ws()
            if self.i < self.n and self.s[self.i] in ":=":
                self.i += 1
            else:
                raise SJSONError("deux-points attendu")
            out[key] = self.value()

    def arr(self) -> list[Any]:
        self.i += 1
        out: list[Any] = []
        while True:
            self.ws()
            if self.i >= self.n:
                raise SJSONError("liste non fermée")
            if self.s[self.i] == "]":
                self.i += 1
                return out
            if self.s[self.i] == ",":
                self.i += 1
                continue
            out.append(self.value())

    def string(self) -> str:
        self.i += 1
        buf = []
        s, n = self.s, self.n
        while self.i < n:
            c = s[self.i]
            if c == '"':
                self.i += 1
                return "".join(buf)
            if c == "\\" and self.i + 1 < n:
                nxt = s[self.i + 1]
                mapping = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "/": "/", "\\": "\\", '"': '"'}
                if nxt == "u" and self.i + 5 < n:
                    try:
                        buf.append(chr(int(s[self.i + 2:self.i + 6], 16)))
                        self.i += 6
                        continue
                    except ValueError:
                        pass
                buf.append(mapping.get(nxt, nxt))
                self.i += 2
                continue
            buf.append(c)
            self.i += 1
        raise SJSONError("chaîne non fermée")

    def bare_key(self) -> str:
        m = re.compile(r"[A-Za-z0-9_\-.$]+").match(self.s, self.i)
        if not m:
            raise SJSONError("clé attendue")
        self.i = m.end()
        return m.group(0)

    def bare(self) -> Any:
        m = re.compile(r"[^\s,\]\}:]+").match(self.s, self.i)
        if not m:
            raise SJSONError(f"valeur invalide à {self.i}")
        self.i = m.end()
        tok = m.group(0)
        if tok == "true":
            return True
        if tok == "false":
            return False
        if tok in ("null", "nil"):
            return None
        try:
            return int(tok)
        except ValueError:
            pass
        try:
            return float(tok)
        except ValueError:
            return tok


def parse_sjson(text: str) -> Any:
    p = _Parser(text)
    value = p.value()
    return value


# ── Lecture du zip ─────────────────────────────────────────────

def _read_json(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> dict[str, Any] | None:
    if info.file_size > MAX_JSON_ENTRY:
        return None
    try:
        data = parse_sjson(zf.read(info).decode("utf-8", errors="replace"))
    except (SJSONError, zipfile.BadZipFile, OSError, RecursionError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _str(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


def _num(v: Any) -> float | int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return v
    # Le jeu convertit lui-même les nombres écrits en texte (sanitizeInfoFile).
    if isinstance(v, str):
        try:
            f = float(v)
            return int(f) if f.is_integer() else f
        except ValueError:
            return None
    return None


_TRANSLATION_KEY = re.compile(r"^[a-zA-Z]+(\.[\w-]+){2,}$")


def _label(v: Any) -> str | None:
    """Texte affichable, ou None si c'est une clé de traduction du jeu (vehiclesData.x.y)."""
    s = _str(v)
    return None if s is None or _TRANSLATION_KEY.match(s) else s


# ── Aperçu ─────────────────────────────────────────────────────

def find_preview_entry(names: list[str]) -> str | None:
    lower = [n.lower() for n in names]
    patterns = [
        lambda e: re.search(r"/preview\.(jpg|jpeg|png|webp)$", e),
        lambda e: re.search(r"/icon\.(jpg|jpeg|png|webp)$", e),
        # skin par défaut d'un véhicule — sans plaques ni gabarits
        lambda e: re.search(r"/default\.(jpg|jpeg|png)$", e) and "licenseplate" not in e and "template" not in e,
        lambda e: re.match(r"^vehicles/[^/]+/[^/]+\.(jpg|png)$", e) and "licenseplate" not in e,
        lambda e: re.match(r"^levels/[^/]+/[^/]+\.(jpg|png)$", e),
    ]
    for pattern in patterns:
        for idx, e in enumerate(lower):
            if pattern(e):
                return names[idx]
    return None


def safe_name(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]", "_", value)


def to_webp(data: bytes, size: tuple[int, int], quality: int) -> bytes:
    with Image.open(io.BytesIO(data)) as img:
        img = ImageOps.exif_transpose(img)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
        fitted = ImageOps.fit(img, size, method=Image.Resampling.LANCZOS)
        out = io.BytesIO()
        fitted.save(out, "WEBP", quality=quality)
        return out.getvalue()


def extract_preview(zf: zipfile.ZipFile, images_dir: str, base_name: str, instance_id: str) -> str | None:
    """Extrait l'aperçu du zip vers `<instance>_<base>.webp` (400×300)."""
    infos = {i.filename: i for i in zf.infolist() if not i.is_dir()}
    entry = find_preview_entry(list(infos))
    if not entry or infos[entry].file_size > MAX_PREVIEW_UNCOMPRESSED:
        return None
    try:
        webp = to_webp(zf.read(infos[entry]), (400, 300), 85)
    except Exception:  # image illisible : pas d'aperçu, ce n'est pas bloquant
        return None
    # Préfixé par l'instance : le dossier d'images est partagé, et deux
    # instances peuvent avoir un mod du même nom.
    dest = f"{safe_name(instance_id)}_{safe_name(base_name)}.webp"
    Path(images_dir).mkdir(parents=True, exist_ok=True)
    (Path(images_dir) / dest).write_bytes(webp)
    return dest


# ── Véhicule ───────────────────────────────────────────────────

ROOT_INFO_RE = re.compile(r"^vehicles/(?!common/)[^/]+/info\.json$", re.I)


def _analyze_vehicle(zf: zipfile.ZipFile, infos: dict[str, zipfile.ZipInfo]) -> dict[str, Any] | None:
    names = list(infos)
    root_info = next((n for n in names if ROOT_INFO_RE.match(n)), None)
    meta: dict[str, Any] = {"configCount": 0, "configurations": [], "drivetrains": [],
                            "fuelTypes": [], "transmissions": []}

    if root_info:
        data = _read_json(zf, infos[root_info])
        if data:
            for key, field in (("brand", "Brand"), ("bodyStyle", "Body Style"), ("vehicleType", "Type"),
                               ("country", "Country"), ("derbyClass", "Derby Class")):
                v = _label(data.get(field))
                if v:
                    meta[key] = v
            years = data.get("Years")
            if isinstance(years, dict):
                for key, field in (("yearMin", "min"), ("yearMax", "max")):
                    v = _num(years.get(field))
                    if v is not None:
                        meta[key] = v

    vehicle_dir = root_info[: root_info.rfind("/") + 1] if root_info else None
    if vehicle_dir:
        config_entries = [n for n in names if n.startswith(vehicle_dir) and re.search(r"/info_[^/]+\.json$", n, re.I)]
        pc_entries = [n for n in names if n.startswith(vehicle_dir) and n.lower().endswith(".pc")
                      and n.count("/") == vehicle_dir.count("/")]
    else:
        config_entries = [n for n in names if re.match(r"^vehicles/[^/]+/info_[^/]+\.json$", n, re.I)]
        pc_entries = [n for n in names if re.match(r"^vehicles/[^/]+/[^/]+\.pc$", n, re.I)]
    config_entries = config_entries[:MAX_CONFIGS_SCANNED]

    drivetrains: list[str] = []
    fuels: list[str] = []
    transmissions: list[str] = []
    configurations: list[str] = []
    named_configs: set[str] = set()
    power: list[float] = []
    offroad: list[float] = []

    def add(lst: list[str], v: Any) -> None:
        s = _label(v)
        if s and s not in lst:
            lst.append(s)

    for entry in config_entries:
        data = _read_json(zf, infos[entry])
        if not data:
            continue
        config_key = re.sub(r"^info_|\.json$", "", entry.rsplit("/", 1)[-1], flags=re.I)
        named_configs.add(config_key.lower())
        name = _label(data.get("Configuration")) or config_key
        configurations.append(name)
        add(drivetrains, data.get("Drivetrain"))
        add(fuels, data.get("Fuel Type"))
        add(transmissions, data.get("Transmission"))
        p = _num(data.get("Power"))
        if p is not None:
            power.append(p)
        # Score maison BeamNG, pas une mesure physique : un indice seulement.
        o = _num(data.get("Off-Road Score"))
        if o is not None:
            offroad.append(o)

    # Configurations livrées en .pc sans info_<config>.json : le jeu les
    # affiche quand même, sous le nom du fichier.
    for entry in pc_entries[:MAX_CONFIGS_SCANNED]:
        key = entry.rsplit("/", 1)[-1][:-3]
        if key.lower() not in named_configs:
            named_configs.add(key.lower())
            configurations.append(key)

    meta["configCount"] = len(configurations)
    meta["configurations"] = configurations[:MAX_CONFIGS_LISTED]
    meta["drivetrains"] = drivetrains
    meta["fuelTypes"] = fuels
    meta["transmissions"] = transmissions
    if power:
        meta["powerMin"], meta["powerMax"] = min(power), max(power)
    if offroad:
        meta["offRoadScoreMin"], meta["offRoadScoreMax"] = min(offroad), max(offroad)

    has_data = meta.get("brand") or meta.get("bodyStyle") or meta.get("vehicleType") or meta["configCount"] > 0
    return meta if has_data else None


# ── Carte ──────────────────────────────────────────────────────

def level_names(names: list[str]) -> list[str]:
    """Dossiers sous levels/ : c'est le nom attendu par `Map =`, casse comprise."""
    found: list[str] = []
    for n in names:
        m = re.match(r"^levels/([^/]+)/", n)
        if m and m.group(1) not in found and m.group(1).lower() != "mod_info":
            found.append(m.group(1))
    return found


def _analyze_map(zf: zipfile.ZipFile, infos: dict[str, zipfile.ZipInfo]) -> dict[str, Any] | None:
    names = list(infos)
    level_info = next((n for n in names if re.match(r"^levels/[^/]+/info\.json$", n, re.I)), None)
    # Métadonnées du repository officiel BeamNG, présentes seulement si le
    # mod vient de là.
    mod_info = next((n for n in names if re.match(r"^mod_info/[^/]+/info\.json$", n, re.I)), None)
    meta: dict[str, Any] = {}
    if level_info:
        data = _read_json(zf, infos[level_info])
        if data:
            if _label(data.get("title")):
                meta["title"] = _label(data.get("title"))
            if _label(data.get("description")):
                meta["description"] = _label(data.get("description"))
            size = data.get("size")
            if isinstance(size, list) and size and _num(size[0]) is not None and _num(size[0]) > 0:
                meta["sizeMeters"] = _num(size[0])
    if mod_info:
        data = _read_json(zf, infos[mod_info])
        if data:
            for key, field in (("author", "username"), ("tagLine", "tag_line"), ("category", "category_title")):
                v = _str(data.get(field))
                if v:
                    meta[key] = v
            if "title" not in meta and _str(data.get("title")):
                meta["title"] = _str(data.get("title"))
    has_data = meta.get("title") or "sizeMeters" in meta or meta.get("tagLine") or meta.get("author")
    return meta if has_data else None


def _other_subtype(names: list[str]) -> str:
    lower = [n.lower() for n in names]
    if any("lua/ge/extensions/" in e or "lua/vehicle/extensions/" in e for e in lower):
        return "script"
    if any(e.startswith("art/sound/") or e.endswith(".ogg") for e in lower):
        return "sound"
    if any("ui/entrypoints/" in e or "ui/modules/" in e for e in lower):
        return "ui"
    if any(e.startswith("art/shapes/") for e in lower) and \
            not any(e.startswith(("vehicles/", "levels/")) for e in lower):
        return "prop"
    return "unknown"


def analyze_contents(zf: zipfile.ZipFile, type_: str) -> dict[str, Any] | None:
    """Métadonnées pratiques ; None si rien d'utile (jamais d'exception)."""
    try:
        infos = {i.filename: i for i in zf.infolist() if not i.is_dir()}
        if type_ == "vehicle":
            v = _analyze_vehicle(zf, infos)
            return {"kind": "vehicle", "vehicle": v} if v else None
        if type_ == "map":
            m = _analyze_map(zf, infos)
            return {"kind": "map", "map": m} if m else None
        sub = _other_subtype(list(infos))
        return {"kind": "other", "other": {"subtype": sub}} if sub != "unknown" else None
    except Exception:
        return None


def clean_filename(name: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[_-]+", " ", name)).strip()


def detect_type(names: list[str], default: str) -> str:
    lower = [n.lower() for n in names]
    if any(e.startswith("levels/") for e in lower):
        return "map"
    # vehicles/common/ = pièces partagées ; seul un info.json à la racine du
    # dossier d'un véhicule définit un véhicule sélectionnable.
    if any(ROOT_INFO_RE.match(e) for e in lower):
        return "vehicle"
    return default


def analyze_zip(path: str, default_dir: str, images_dir: str, base_name: str, instance_id: str) -> dict[str, Any]:
    """Analyse complète pour le scan-import : type, nom, aperçu, métadonnées."""
    with zipfile.ZipFile(path) as zf:
        names = [i.filename for i in zf.infolist() if not i.is_dir()]
        type_ = detect_type(names, "map" if default_dir == "inactive_map" else "mod")
        name = clean_filename(base_name)
        info_entry = next((n for n in names if n.lower().endswith("/info.json") or n.lower() == "info.json"), None)
        if info_entry:
            data = _read_json(zf, zf.getinfo(info_entry))
            if data:
                n = _label(data.get("Name")) or _label(data.get("name"))
                if n:
                    name = n
        image = extract_preview(zf, images_dir, base_name, instance_id)
        metadata = analyze_contents(zf, type_)
    return {"name": name, "type": type_, "imageFilename": image, "metadata": metadata}


def analyze_upload(path: str, type_: str, images_dir: str, base_name: str, instance_id: str) -> tuple[str | None, dict[str, Any] | None]:
    try:
        with zipfile.ZipFile(path) as zf:
            return extract_preview(zf, images_dir, base_name, instance_id), analyze_contents(zf, type_)
    except (zipfile.BadZipFile, OSError):
        return None, None


def analyze_metadata(path: str, type_: str) -> dict[str, Any] | None:
    with zipfile.ZipFile(path) as zf:
        return analyze_contents(zf, type_)
