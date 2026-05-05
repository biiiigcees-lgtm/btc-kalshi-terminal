import os
import joblib
import pandas as pd
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

FEATURES_PATH = os.getenv("FEATURES_PATH", "/data/features.csv")
MODEL_INPUT_PATH = os.getenv("MODEL_OUTPUT_PATH", "/models/model.pkl")
ONNX_OUTPUT_PATH = os.getenv("ONNX_OUTPUT_PATH", "/models/model.onnx")


if __name__ == "__main__":
    if not os.path.exists(MODEL_INPUT_PATH):
        raise FileNotFoundError(f"Trained model not found at {MODEL_INPUT_PATH}")

    if not os.path.exists(FEATURES_PATH):
        raise FileNotFoundError(f"Dataset not found at {FEATURES_PATH}")

    df = pd.read_csv(FEATURES_PATH)
    if "label" not in df.columns:
        raise ValueError("Input dataset must include a 'label' column")

    feature_names = [c for c in df.columns if c != "label"]
    n_features = len(feature_names)

    model = joblib.load(MODEL_INPUT_PATH)
    initial_types = [("float_input", FloatTensorType([None, n_features]))]
    onnx_model = convert_sklearn(model, initial_types=initial_types)

    os.makedirs(os.path.dirname(ONNX_OUTPUT_PATH), exist_ok=True)
    with open(ONNX_OUTPUT_PATH, "wb") as f:
        f.write(onnx_model.SerializeToString())

    print(f"ONNX model exported successfully: {ONNX_OUTPUT_PATH}")
