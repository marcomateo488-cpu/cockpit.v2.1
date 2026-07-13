import base64
from io import BytesIO
import barcode
from barcode.writer import ImageWriter

def generate_barcode_base64(data: str) -> str:
    """Generates a Code128 barcode and returns it as a Base64 encoded string."""
    code128 = barcode.get_barcode_class('code128')
    rv = BytesIO()
    code128(data, writer=ImageWriter()).write(rv)
    rv.seek(0)
    return base64.b64encode(rv.read()).decode('utf-8')
