"""Extract document text without pretending binary files are plain TXT."""
from io import BytesIO
from pathlib import Path
import zipfile


class DocumentError(ValueError):
    pass


def validate_text(text, max_chars):
    if not isinstance(text, str) or len(text.strip()) < 100:
        raise DocumentError("内容为空或太短，请提供至少 100 个字符的正文。")
    if len(text) > max_chars:
        raise DocumentError(f"全文有 {len(text):,} 个字符，超过当前上限 {max_chars:,}。请提高 NOVEL_MAX_ANALYSIS_TEXT_LENGTH 后重试；系统不会截断原文。")
    return text


def load_document(data, filename, max_chars=20_000_000, max_expanded_bytes=256 * 1024 * 1024):
    extension = Path(filename).suffix.lower()
    if extension not in {".txt", ".docx", ".pdf"}:
        raise DocumentError("仅支持 TXT、DOCX 和含可复制文字的 PDF 文件。")
    if not data:
        raise DocumentError("上传的文件为空。")
    if extension == ".txt":
        encodings = ("utf-16",) if data.startswith((b"\xff\xfe", b"\xfe\xff")) else ("utf-8-sig", "gb18030")
        for encoding in encodings:
            try:
                text = data.decode(encoding)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise DocumentError("TXT 编码无法识别，请转换为 UTF-8、GB18030 或带 BOM 的 UTF-16。")
        if "\x00" in text:
            raise DocumentError("文件包含二进制数据，或使用了不支持的编码，请上传 UTF-8、GB18030 或带 BOM 的 UTF-16 TXT。")
    elif extension == ".docx":
        try:
            from docx import Document
            with zipfile.ZipFile(BytesIO(data)) as archive:
                if sum(item.file_size for item in archive.infolist()) > max_expanded_bytes:
                    raise DocumentError("DOCX 解压后的内容超过安全大小限制。")
            document = Document(BytesIO(data))
            ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
            parts = []
            chars = 0
            # Includes table paragraphs and hyperlink text in document order.
            for paragraph in document.element.body.iter(ns + "p"):
                line = "".join((node.text or "") if node.tag == ns + "t" else
                               "\t" if node.tag == ns + "tab" else "\n"
                               for node in paragraph.iter() if node.tag in {ns + "t", ns + "tab", ns + "br"})
                chars += len(line) + (1 if parts else 0)
                if chars > max_chars:
                    raise DocumentError(f"DOCX 正文超过 {max_chars:,} 字符上限；未截断或提交分析。")
                parts.append(line)
            text = "\n".join(parts)
        except ImportError as exc:
            raise DocumentError("缺少 python-docx，请安装 requirements.txt 中的依赖。") from exc
        except DocumentError:
            raise
        except Exception as exc:
            raise DocumentError("DOCX 无法读取，请确认文件未损坏且为有效的 .docx 文档。") from exc
    else:
        try:
            from pypdf import PdfReader
            reader = PdfReader(BytesIO(data))
            if reader.is_encrypted:
                raise DocumentError("请先解密 PDF 后再上传。")
            pages = []
            chars = 0
            for number, page in enumerate(reader.pages, 1):
                text = page.extract_text() or ""
                if not text.strip() and page.get_contents() is not None:
                    raise DocumentError(f"PDF 第 {number} 页没有可提取正文，可能是扫描页。请先 OCR 并核对完整文本后再上传。")
                chars += len(text) + (2 if pages else 0)
                if chars > max_chars:
                    raise DocumentError(f"PDF 正文超过 {max_chars:,} 字符上限；未截断或提交分析。")
                pages.append(text)
            text = "\n\n".join(pages)
        except ImportError as exc:
            raise DocumentError("缺少 pypdf，请安装 requirements.txt 中的依赖。") from exc
        except DocumentError:
            raise
        except Exception as exc:
            raise DocumentError("PDF 无法读取，请确认文件未损坏且含有可复制正文。") from exc
    return validate_text(text, max_chars)
