import os
import pandas as pd
import xgboost as xgb
import joblib

FEATURES_PATH = os.getenv("FEATURES_PATH", "/data/features.csv")
MODEL_OUTPUT_PATH = os.getenv("MODEL_OUTPUT_PATH", "/models/model.pkl")


if __name__ == "__main__":
    if not os.path.exists(FEATURES_PATH):
        raise FileNotFoundError(f"Dataset not found at {FEATURES_PATH}")

    df = pd.read_csv(FEATURES_PATH)
    if "label" not in df.columns:
        raise ValueError("Input dataset must include a 'label' column")

    X = df.drop("label", axis=1)
    y = df["label"]

    model = xgb.XGBClassifier(
        n_estimators=200,
        max_depth=5,
        learning_rate=0.05,
        random_state=42,
        eval_metric="logloss",
    )

    model.fit(X, y)

    os.makedirs(os.path.dirname(MODEL_OUTPUT_PATH), exist_ok=True)
    joblib.dump(model, MODEL_OUTPUT_PATH)

    print(f"Model trained successfully: {MODEL_OUTPUT_PATH}")
