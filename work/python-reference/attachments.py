"""Validation of image and file attachments on a prompt, and their mapping to ACP content blocks."""
import base64
import hashlib
import re
import unicodedata
import urllib.parse


MAX_IMAGES = 4
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 15 * 1024 * 1024
MAX_EVENT_IMAGE_BYTES = 32 * 1024 * 1024


def validate_image_attachments(attachments):
    if not isinstance(attachments, list) or not 1 <= len(attachments) <= MAX_IMAGES:
        raise ValueError(f'Attach between 1 and {MAX_IMAGES} images')
    validated, total = [], 0
    signatures = {
        'image/png': lambda b: b.startswith(b'\x89PNG\r\n\x1a\n'),
        'image/jpeg': lambda b: b.startswith(b'\xff\xd8\xff'),
        'image/gif': lambda b: b.startswith((b'GIF87a', b'GIF89a')),
        'image/webp': lambda b: len(b) >= 12 and b.startswith(b'RIFF') and b[8:12] == b'WEBP',
    }
    for item in attachments:
        if not isinstance(item, dict) or set(item) - {'type', 'mimeType', 'data'} or item.get('type', 'image') != 'image':
            raise ValueError('Each image must contain only mimeType and base64 data')
        mime, encoded = item.get('mimeType'), item.get('data')
        if mime not in signatures:
            raise ValueError('Images must be PNG, JPEG, GIF, or WebP')
        if not isinstance(encoded, str) or not encoded or len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
            raise ValueError('Image data is empty or exceeds the 5 MiB limit')
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, base64.binascii.Error) as error:
            raise ValueError('Image data must be valid base64') from error
        if not raw or len(raw) > MAX_IMAGE_BYTES:
            raise ValueError('Image data is empty or exceeds the 5 MiB limit')
        if not signatures[mime](raw):
            raise ValueError(f'Image data does not match {mime}')
        total += len(raw)
        if total > MAX_TOTAL_IMAGE_BYTES:
            raise ValueError('Images exceed the 15 MiB total limit')
        validated.append({'type': 'image', 'mimeType': mime, 'data': encoded})
    return validated, total


# ---- File (non-image) attachments -------------------------------------------------------------
MAX_FILES = 8
MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024
MAX_BINARY_FILE_BYTES = 10 * 1024 * 1024
MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024  # images and files together
MAX_PROMPT_BODY_BYTES = 30 * 1024 * 1024  # 20 MiB as base64 (26.7 MiB) plus names and typed text
MAX_EVENT_FILE_PREVIEW_CHARS = 4000
MAX_FILE_NAME_CHARS = 200
_MIME_PATTERN = re.compile(r'^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$')
_TEXT_MIME_EXACT = {
    'application/json', 'application/xml', 'application/javascript', 'application/x-javascript', 'application/ecmascript',
    'application/typescript', 'application/x-typescript', 'application/yaml', 'application/x-yaml', 'application/toml',
    'application/sql', 'application/x-sql', 'application/x-sh', 'application/x-httpd-php', 'application/xhtml+xml',
    'application/x-ndjson', 'application/csv', 'application/x-python', 'application/x-python-code', 'application/x-ruby',
}
_NEUTRAL_MIMES = {'', 'application/octet-stream', 'binary/octet-stream'}
_BINARY_ONLY_MIMES = {'application/pdf', 'application/zip', 'application/gzip', 'application/x-tar', 'application/x-7z-compressed',
                      'application/x-rar-compressed', 'application/vnd.rar'}
_TEXT_EXTENSIONS = {
    'txt': 'text/plain', 'text': 'text/plain', 'log': 'text/plain', 'md': 'text/markdown', 'markdown': 'text/markdown',
    'json': 'application/json', 'jsonl': 'application/x-ndjson', 'ndjson': 'application/x-ndjson', 'csv': 'text/csv', 'tsv': 'text/tab-separated-values',
    'py': 'text/x-python', 'js': 'text/javascript', 'mjs': 'text/javascript', 'cjs': 'text/javascript', 'ts': 'text/typescript',
    'tsx': 'text/typescript', 'jsx': 'text/javascript', 'yaml': 'application/yaml', 'yml': 'application/yaml', 'toml': 'application/toml',
    'xml': 'application/xml', 'html': 'text/html', 'htm': 'text/html', 'css': 'text/css', 'sql': 'application/sql', 'sh': 'application/x-sh',
    'ini': 'text/plain', 'cfg': 'text/plain', 'conf': 'text/plain', 'env': 'text/plain', 'rs': 'text/x-rust', 'go': 'text/x-go',
    'java': 'text/x-java', 'c': 'text/x-c', 'h': 'text/x-c', 'cpp': 'text/x-c++', 'hpp': 'text/x-c++', 'cs': 'text/x-csharp',
    'rb': 'text/x-ruby', 'php': 'text/x-php', 'swift': 'text/x-swift', 'kt': 'text/x-kotlin', 'ps1': 'text/plain', 'bat': 'text/plain',
    'svg': 'image/svg+xml', 'diff': 'text/x-diff', 'patch': 'text/x-diff', 'tex': 'text/x-tex', 'rst': 'text/x-rst',
}
_BINARY_EXTENSIONS = {'pdf': 'application/pdf', 'zip': 'application/zip', 'gz': 'application/gzip', 'wav': 'audio/wav', 'mp3': 'audio/mpeg',
                      'ogg': 'audio/ogg', 'flac': 'audio/flac', 'm4a': 'audio/mp4', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'}
_PICTURE_MIMES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}


def validate_attachment_name(name):
    """Names are display-only labels. Anything that could look like a path, drive, device or control sequence is refused."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError('Each file needs a name')
    if len(name) > MAX_FILE_NAME_CHARS:
        raise ValueError(f'File name is longer than {MAX_FILE_NAME_CHARS} characters')
    if name != name.strip() or name.strip('.') == '' or name.endswith('.'):
        raise ValueError(f'File name {name[:40]!r} is not allowed (leading/trailing space, dots only, or trailing dot)')
    if any(unicodedata.category(ch) in ('Cc', 'Cf', 'Cs', 'Co', 'Cn', 'Zl', 'Zp') for ch in name):
        raise ValueError(f'File name {name[:40]!r} contains control, invisible or direction-changing characters')
    if any(ch in name for ch in '/\\:<>"|?*'):
        raise ValueError(f'File name {name[:40]!r} must not contain path separators or any of : < > " | ? *')
    return name


def _normal_mime(value):
    if value is None:
        return ''
    if not isinstance(value, str):
        raise ValueError('File type must be a string')
    mime = value.split(';', 1)[0].strip().lower()
    if mime and not _MIME_PATTERN.match(mime):
        raise ValueError(f'File type {value[:60]!r} is not a valid MIME type')
    return mime


def _extension(name):
    return name.rsplit('.', 1)[-1].lower() if '.' in name.strip('.') else ''


def _is_text_mime(mime):
    return mime.startswith('text/') or mime in _TEXT_MIME_EXACT or mime.endswith(('+json', '+xml'))


def _decode_text(raw):
    """Valid UTF-8 without NUL bytes, or None. A leading byte-order mark is dropped."""
    if b'\x00' in raw:
        return None
    try:
        return raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return None


def classify_file(name, declared_mime, raw):
    """Return (kind, mimeType, text) where kind is 'text', 'audio' or 'binary'. Never reads or writes the disk."""
    mime, ext = _normal_mime(declared_mime), _extension(name)
    major = mime.split('/', 1)[0]
    text = None
    could_be_text = mime == 'image/svg+xml' or (mime not in _BINARY_ONLY_MIMES and major not in ('image', 'audio', 'video', 'font')
                                                and (_is_text_mime(mime) or (mime in _NEUTRAL_MIMES and ext not in _BINARY_EXTENSIONS) or ext in _TEXT_EXTENSIONS))
    if could_be_text:
        text = _decode_text(raw)
    if text is not None:
        return 'text', (mime if _is_text_mime(mime) or mime == 'image/svg+xml' else _TEXT_EXTENSIONS.get(ext, 'text/plain')), text
    if not mime or mime in _NEUTRAL_MIMES:
        mime = _BINARY_EXTENSIONS.get(ext, 'application/octet-stream')
    return ('audio' if mime.startswith('audio/') else 'binary'), mime, None


def validate_file_attachments(attachments):
    """Validate non-image attachments: {'type': 'file', 'name', 'mimeType', 'data': base64}. Returns (records, total_bytes)."""
    if not isinstance(attachments, list) or not 1 <= len(attachments) <= MAX_FILES:
        raise ValueError(f'Attach between 1 and {MAX_FILES} files')
    records, total = [], 0
    for item in attachments:
        if not isinstance(item, dict) or set(item) - {'type', 'name', 'mimeType', 'data'} or item.get('type') != 'file':
            raise ValueError('Each file must contain only type "file", name, mimeType and base64 data')
        name = validate_attachment_name(item.get('name'))
        mime = _normal_mime(item.get('mimeType'))
        if mime in _PICTURE_MIMES:
            raise ValueError(f'{name}: attach PNG, JPEG, GIF and WebP pictures as images, not as files')
        encoded = item.get('data')
        if not isinstance(encoded, str) or not encoded or len(encoded) > 4 * ((MAX_BINARY_FILE_BYTES + 2) // 3):
            raise ValueError(f'{name}: file is empty or exceeds the {MAX_BINARY_FILE_BYTES // 1048576} MiB limit')
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, base64.binascii.Error) as error:
            raise ValueError(f'{name}: file data must be valid base64') from error
        if not raw:
            raise ValueError(f'{name}: file is empty')
        kind, mime, text = classify_file(name, mime, raw)
        limit = MAX_TEXT_FILE_BYTES if kind == 'text' else MAX_BINARY_FILE_BYTES
        if len(raw) > limit:
            raise ValueError(f'{name}: {kind} file exceeds the {limit // 1048576} MiB limit')
        total += len(raw)
        if total > MAX_TOTAL_ATTACHMENT_BYTES:
            raise ValueError(f'Attachments exceed the {MAX_TOTAL_ATTACHMENT_BYTES // 1048576} MiB total limit')
        records.append({'name': name, 'mimeType': mime, 'size': len(raw), 'kind': kind, 'text': text,
                        'data': None if kind == 'text' else encoded, 'sha256': hashlib.sha256(raw).hexdigest()})
    return records, total


def split_attachments(attachments):
    """Separate the image items (type 'image' or untyped, as before) from the file items."""
    if not isinstance(attachments, list):
        raise ValueError('Attachments must be a list')
    images, files = [], []
    for item in attachments:
        kind = item.get('type', 'image') if isinstance(item, dict) else None
        if kind == 'image':
            images.append(item)
        elif kind == 'file':
            files.append(item)
        else:
            raise ValueError('Each attachment must be an image or a file')
    return images, files


def format_size(count):
    return f'{count} B' if count < 1024 else f'{count / 1024:.1f} KB' if count < 1048576 else f'{count / 1048576:.1f} MB'


def _fence(text):
    longest = max((len(run) for run in re.findall(r'`+', text)), default=0)
    return '`' * max(3, longest + 1)


def map_file_attachments(records, prompt_capabilities):
    """Map validated files to ACP content blocks according to the agent's promptCapabilities.
    Returns (blocks, summaries); raises one ValueError naming every file the agent cannot take. Nothing is dropped silently."""
    caps = prompt_capabilities if isinstance(prompt_capabilities, dict) else {}
    embedded, audio = caps.get('embeddedContext') is True, caps.get('audio') is True
    blocks, summaries, refused = [], [], []
    for number, record in enumerate(records, 1):
        name, mime, kind = record['name'], record['mimeType'], record['kind']
        uri = 'attachment:///' + str(number) + '/' + urllib.parse.quote(name, safe='')
        summary = {'name': name, 'mimeType': mime, 'size': record['size'], 'kind': kind}
        if kind == 'text':
            text = record['text']
            if embedded:
                blocks.append({'type': 'resource', 'resource': {'uri': uri, 'mimeType': mime, 'text': text}})
                summary['mode'] = 'embedded'
            else:
                fence = _fence(text)
                body = text if text.endswith('\n') else text + '\n'
                blocks.append({'type': 'text', 'text': f'Attached file: {name} ({mime}, {format_size(record["size"])})\n{fence}\n{body}{fence}'})
                summary['mode'] = 'inline'
            summary['preview'] = text[:MAX_EVENT_FILE_PREVIEW_CHARS]
            summary['truncated'] = len(text) > MAX_EVENT_FILE_PREVIEW_CHARS
        elif kind == 'audio' and audio:
            blocks.append({'type': 'audio', 'mimeType': mime, 'data': record['data']})
            summary['mode'] = 'audio'
        elif embedded:
            blocks.append({'type': 'resource', 'resource': {'uri': uri, 'mimeType': mime, 'blob': record['data']}})
            summary['mode'] = 'embedded'
        else:
            need = 'audio input (promptCapabilities.audio) or embedded context (promptCapabilities.embeddedContext)' if kind == 'audio' else 'embedded context (promptCapabilities.embeddedContext)'
            refused.append(f'{name} ({mime}): this agent does not advertise {need}, so it cannot take this {"audio" if kind == "audio" else "binary"} file')
        summaries.append(summary)
    if refused:
        raise ValueError('; '.join(refused) + '. Text files can still be attached.')
    return blocks, summaries


def _event_image_size(event):
    data = event.get('data', {})
    attachments = data.get('attachments', []) if isinstance(data, dict) else []
    return sum(len(item.get('data', '')) for item in attachments if isinstance(item, dict) and isinstance(item.get('data'), str))
