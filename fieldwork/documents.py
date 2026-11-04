import base64
import binascii
import io
import re
import xml.etree.ElementTree as ET
import zipfile


MAX_DOCUMENT = 1024 * 1024
ALLOWED_EXTENSIONS = {".txt", ".md", ".docx", ".pdf"}


class DocumentError(Exception):
    pass


def _docx_text(content):
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            xml_content = archive.read("word/document.xml")
        root = ET.fromstring(xml_content)
        text = " ".join(
            node.text or ""
            for node in root.iter()
            if node.tag.endswith("}t")
        )
        return re.sub(r"\s+", " ", text).strip()
    except (KeyError, OSError, zipfile.BadZipFile, ET.ParseError):
        raise DocumentError("This DOCX file could not be read.")


def extract(filename, encoded):
    if not isinstance(filename, str) or len(filename) > 255:
        raise DocumentError("Document filename must be 255 characters or fewer.")
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    extension = "." + suffix
    if extension not in ALLOWED_EXTENSIONS:
        raise DocumentError("Choose a TXT, Markdown, DOCX, or PDF file.")
    if not isinstance(encoded, str) or len(encoded) > (MAX_DOCUMENT * 4 // 3) + 8:
        raise DocumentError("Document exceeds the 1 MB size limit.")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise DocumentError("Document upload is not valid base64 data.")
    if len(content) > MAX_DOCUMENT:
        raise DocumentError("Document exceeds the 1 MB size limit.")

    if extension in (".txt", ".md"):
        try:
            text = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise DocumentError("Text documents must use UTF-8 encoding.")
    elif extension == ".docx":
        text = _docx_text(content)
    else:
        try:
            from pypdf.errors import PdfReadError
            from pypdf import PdfReader
        except ImportError:
            raise DocumentError("PDF text extraction needs the optional pypdf package. Install it with: python3 -m pip install pypdf")
        try:
            reader = PdfReader(io.BytesIO(content))
            if len(reader.pages) > 80:
                raise DocumentError("PDFs are limited to 80 pages.")
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
        except DocumentError:
            raise
        except (OSError, ValueError, KeyError, PdfReadError) as error:
            raise DocumentError("PDF text extraction failed: {}.".format(error))
    text = text.strip()
    if not text:
        raise DocumentError("No readable text was found in that document.")
    if len(text) > 20000:
        text = text[:20000]
    return text
